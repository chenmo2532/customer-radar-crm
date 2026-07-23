const weights = { value: .25, intent: .25, activity: .15, relationship: .15, payment: .10, riskControl: .10 };

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    const path = url.pathname.replace(/^\/api\/?/, "");
    const method = context.request.method;

    if (method === "OPTIONS") return json({}, 204);
    if (path === "health" && method === "GET") return json({ ok: true, service: "customer-radar-crm" });
    if (path === "login" && method === "POST") return login(context);
    if (path === "logout" && method === "POST") return logout(context);
    if (path === "me" && method === "GET") {
      const user = await currentUser(context);
      return json({ user });
    }

    const user = await currentUser(context);
    if (!user) return json({ error: "未登录" }, 401);

    if (path === "state" && method === "GET") return state(context, user);
    if (path === "customers/export" && method === "GET") return exportCustomers(context, user);
    if (path === "customers/import" && method === "POST") return importCustomers(context, user);
    if (path === "customers" && method === "POST") return createCustomer(context, user);
    if (path.startsWith("customers/") && path.endsWith("/restore") && method === "PUT") {
      return restoreCustomer(context, user, path.split("/")[1]);
    }
    if (path.startsWith("customers/") && method === "PUT") return updateCustomer(context, user, path.split("/")[1]);
    if (path.startsWith("customers/") && method === "DELETE") return deleteCustomer(context, user, path.split("/")[1]);
    if (path === "followups" && method === "POST") return createFollowup(context, user);
    if (path === "daily-reports" && method === "POST") return saveDailyReport(context, user);
    if (path === "users" && method === "GET") return listUsers(context, user);
    if (path === "users" && method === "POST") return createUser(context, user);
    if (path.startsWith("users/") && path.endsWith("/password") && method === "PUT") {
      return resetUserPassword(context, user, path.split("/")[1]);
    }
    if (path.startsWith("users/") && method === "DELETE") return deleteUser(context, user, path.split("/")[1]);

    return json({ error: "接口不存在" }, 404);
  } catch (error) {
    return json({ error: error.message || "服务器错误" }, 500);
  }
}

async function login({ request, env }) {
  const body = await request.json();
  const passwordHash = await sha256(body.password || "");
  const user = await env.DB.prepare(
    "SELECT id, name, account, role FROM users WHERE account = ? AND password_hash = ?"
  ).bind(body.account || "", passwordHash).first();

  if (!user) return json({ error: "账号或密码错误" }, 401);

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, user.id, expiresAt).run();

  const response = json({ user });
  response.headers.append("Set-Cookie", cookie("crm_session", token, 60 * 60 * 24 * 7));
  return response;
}

async function logout({ request, env }) {
  const token = getCookie(request, "crm_session");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  const response = json({ ok: true });
  response.headers.append("Set-Cookie", "crm_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return response;
}

async function currentUser({ request, env }) {
  const token = getCookie(request, "crm_session");
  if (!token) return null;
  const row = await env.DB.prepare(`
    SELECT users.id, users.name, users.account, users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ? AND sessions.expires_at > datetime('now')
  `).bind(token).first();
  return row || null;
}

async function state({ env }, user) {
  const isAdmin = isAdminUser(user);
  const customersResult = isAdmin
    ? await env.DB.prepare("SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY created_at DESC").all()
    : await env.DB.prepare("SELECT * FROM customers WHERE deleted_at IS NULL AND (created_by = ? OR owner = ?) ORDER BY created_at DESC")
      .bind(user.id, user.name).all();

  const deletedCustomersResult = isAdmin
    ? await env.DB.prepare("SELECT * FROM customers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all()
    : await env.DB.prepare("SELECT * FROM customers WHERE deleted_at IS NOT NULL AND (created_by = ? OR owner = ?) ORDER BY deleted_at DESC")
      .bind(user.id, user.name).all();

  const followupsResult = isAdmin
    ? await env.DB.prepare(`
        SELECT followups.*
        FROM followups
        JOIN customers ON customers.id = followups.customer_id
        WHERE customers.deleted_at IS NULL
        ORDER BY followups.followup_date DESC, followups.created_at DESC
      `).all()
    : await env.DB.prepare(`
        SELECT followups.*
        FROM followups
        JOIN customers ON customers.id = followups.customer_id
        WHERE customers.deleted_at IS NULL AND (customers.created_by = ? OR customers.owner = ?)
        ORDER BY followups.followup_date DESC, followups.created_at DESC
      `).bind(user.id, user.name).all();

  const reportsResult = isAdmin
    ? await env.DB.prepare("SELECT * FROM daily_reports ORDER BY report_date DESC, updated_at DESC LIMIT 120").all()
    : await env.DB.prepare("SELECT * FROM daily_reports WHERE user_id = ? ORDER BY report_date DESC, updated_at DESC LIMIT 120")
      .bind(user.id).all();

  return json({
    user,
    customers: customersResult.results.map(mapCustomer),
    deletedCustomers: deletedCustomersResult.results.map(mapCustomer),
    followups: followupsResult.results.map(mapFollowup),
    dailyReports: reportsResult.results.map(mapDailyReport)
  });
}

async function createCustomer({ request, env }, user) {
  const input = await request.json();
  const id = crypto.randomUUID();
  const tags = String(input.tags || "").split(/[，,]/).map(item => item.trim()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  await env.DB.prepare(`
    INSERT INTO customers (
      id, name, company_name, preferred_style, industry, region, owner, stage, budget, contact, phone, source, tags,
      next_follow_up, last_follow_up, score_value, score_intent, score_activity,
      score_relationship, score_payment, score_risk_control, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.name || "未命名客户",
    input.companyName || "",
    input.preferredStyle || "",
    input.industry || "未填写",
    input.region || "未填写",
    input.owner || user.name,
    input.stage || "新线索",
    Number(input.budget || 0),
    input.contact || "",
    input.phone || "",
    input.source || "",
    JSON.stringify(tags),
    input.nextFollowUp || today,
    input.lastFollowUp || today,
    clamp(input.value),
    clamp(input.intent),
    clamp(input.activity),
    clamp(input.relationship),
    clamp(input.payment),
    clamp(input.riskControl),
    user.id
  ).run();

  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
  return json({ customer: mapCustomer(customer) }, 201);
}

async function updateCustomer({ request, env }, user, customerId) {
  if (!customerId) return json({ error: "缺少客户 ID" }, 400);

  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return json({ error: "客户不存在" }, 404);
  if (!isAdminUser(user) && customer.created_by !== user.id && customer.owner !== user.name) {
    return json({ error: "无权修改该客户" }, 403);
  }

  const input = await request.json();
  const tags = String(input.tags || "").split(/[，,]/).map(item => item.trim()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  await env.DB.prepare(`
    UPDATE customers
    SET name = ?, company_name = ?, preferred_style = ?, industry = ?, region = ?, owner = ?, stage = ?, budget = ?,
        contact = ?, phone = ?, source = ?, tags = ?, next_follow_up = ?,
        last_follow_up = ?, score_value = ?, score_intent = ?, score_activity = ?,
        score_relationship = ?, score_payment = ?, score_risk_control = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(
    input.name || "未命名客户",
    input.companyName || "",
    input.preferredStyle || "",
    input.industry || "未填写",
    input.region || "未填写",
    input.owner || user.name,
    input.stage || "新线索",
    Number(input.budget || 0),
    input.contact || "",
    input.phone || "",
    input.source || "",
    JSON.stringify(tags),
    input.nextFollowUp || today,
    input.lastFollowUp || today,
    clamp(input.value),
    clamp(input.intent),
    clamp(input.activity),
    clamp(input.relationship),
    input.payment === undefined ? customer.score_payment : clamp(input.payment),
    input.riskControl === undefined ? customer.score_risk_control : clamp(input.riskControl),
    customerId
  ).run();

  const updated = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  return json({ customer: mapCustomer(updated) });
}

async function deleteCustomer({ env }, user, customerId) {
  if (!customerId) return json({ error: "缺少客户 ID" }, 400);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return json({ error: "客户不存在" }, 404);
  if (!canAccessCustomer(user, customer)) return json({ error: "无权删除该客户" }, 403);
  if (customer.deleted_at) return json({ ok: true });

  await env.DB.prepare("UPDATE customers SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(customerId).run();
  return json({ ok: true });
}

async function restoreCustomer({ env }, user, customerId) {
  if (!customerId) return json({ error: "缺少客户 ID" }, 400);
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  if (!customer) return json({ error: "客户不存在" }, 404);
  if (!canAccessCustomer(user, customer)) return json({ error: "无权恢复该客户" }, 403);

  await env.DB.prepare("UPDATE customers SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .bind(customerId).run();
  const restored = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
  return json({ customer: mapCustomer(restored) });
}

async function exportCustomers({ env }, user) {
  const result = isAdminUser(user)
    ? await env.DB.prepare("SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY created_at DESC").all()
    : await env.DB.prepare("SELECT * FROM customers WHERE deleted_at IS NULL AND (created_by = ? OR owner = ?) ORDER BY created_at DESC")
      .bind(user.id, user.name).all();

  const rows = result.results.map(mapCustomer);
  const headers = [
    "客户名称", "公司名称", "意向款式", "行业", "地区", "负责人", "阶段", "年预算万元",
    "联系人职位", "联系方式", "客户来源", "标签", "下次跟进", "最近跟进",
    "客户价值", "成交意向", "活跃度", "关系深度", "综合评分", "分层"
  ];
  const lines = [
    headers.map(csvCell).join(","),
    ...rows.map(customer => [
      customer.name, customer.companyName, customer.preferredStyle, customer.industry, customer.region,
      customer.owner, customer.stage, customer.budget, customer.contact, customer.phone, customer.source,
      customer.tags.join("，"), customer.nextFollowUp, customer.lastFollowUp, customer.scores.value,
      customer.scores.intent, customer.scores.activity, customer.scores.relationship, customer.score, customer.tier
    ].map(csvCell).join(","))
  ];
  return new Response("\ufeff" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`
    }
  });
}

async function importCustomers({ request, env }, user) {
  const input = await request.json();
  const rows = parseCsv(String(input.csv || ""));
  if (rows.length < 2) return json({ error: "请粘贴包含表头和至少一行客户数据的 CSV" }, 400);

  const headers = rows[0].map(normalizeHeader);
  const dataRows = rows.slice(1).filter(row => row.some(cell => String(cell || "").trim()));
  if (!dataRows.length) return json({ error: "没有可导入的客户数据" }, 400);
  if (dataRows.length > 300) return json({ error: "一次最多导入 300 行客户" }, 400);

  let imported = 0;
  const errors = [];
  for (const [index, row] of dataRows.entries()) {
    const record = {};
    headers.forEach((header, columnIndex) => { record[header] = String(row[columnIndex] || "").trim(); });
    try {
      await insertImportedCustomer(env, user, record);
      imported += 1;
    } catch (error) {
      errors.push(`第 ${index + 2} 行：${error.message}`);
    }
  }

  return json({ imported, failed: errors.length, errors: errors.slice(0, 8) });
}

async function insertImportedCustomer(env, user, record) {
  const id = crypto.randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const tags = String(pick(record, "tags", "标签") || "").split(/[，,]/).map(item => item.trim()).filter(Boolean);
  await env.DB.prepare(`
    INSERT INTO customers (
      id, name, company_name, preferred_style, industry, region, owner, stage, budget, contact, phone, source, tags,
      next_follow_up, last_follow_up, score_value, score_intent, score_activity,
      score_relationship, score_payment, score_risk_control, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    pick(record, "name", "客户名称", "客户名") || "未命名客户",
    pick(record, "companyname", "公司名称") || "",
    pick(record, "preferredstyle", "意向款式", "款式") || "",
    pick(record, "industry", "行业") || "未填写",
    pick(record, "region", "地区") || "未填写",
    pick(record, "owner", "负责人") || user.name,
    normalizeStage(pick(record, "stage", "阶段") || "新线索"),
    Number(pick(record, "budget", "年预算万元", "预算") || 0),
    pick(record, "contact", "联系人职位", "联系人") || "",
    pick(record, "phone", "联系方式", "电话", "手机") || "",
    pick(record, "source", "客户来源", "来源") || "",
    JSON.stringify(tags),
    normalizeDate(pick(record, "nextfollowup", "下次跟进") || today, today),
    normalizeDate(pick(record, "lastfollowup", "最近跟进") || today, today),
    clamp(pick(record, "value", "客户价值")),
    clamp(pick(record, "intent", "成交意向")),
    clamp(pick(record, "activity", "活跃度")),
    clamp(pick(record, "relationship", "关系深度")),
    clamp(pick(record, "payment", "回款健康")),
    clamp(pick(record, "riskcontrol", "风险控制")),
    user.id
  ).run();
}

async function createFollowup({ request, env }, user) {
  const input = await request.json();
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(input.customerId || "").first();
  if (!customer) return json({ error: "客户不存在" }, 404);
  if (customer.deleted_at) return json({ error: "客户已删除，请先恢复后再记录跟进" }, 400);
  if (!isAdminUser(user) && customer.created_by !== user.id && customer.owner !== user.name) {
    return json({ error: "无权操作该客户" }, 403);
  }

  const id = crypto.randomUUID();
  const date = new Date().toISOString().slice(0, 10);
  const method = input.method || "电话";
  const result = input.result || "有意向";

  await env.DB.prepare(`
    INSERT INTO followups (id, customer_id, followup_date, method, result, content, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, input.customerId, date, method, result, input.content || "", user.name).run();

  const nextStage = result === "有意向" ? customer.stage : result;
  const activity = Math.min(100, customer.score_activity + 12);
  const intent = ["需求确认", "报价中", "成交"].includes(result) ? Math.min(100, customer.score_intent + 8) : customer.score_intent;
  const relationship = ["拜访", "会议"].includes(method) ? Math.min(100, customer.score_relationship + 6) : customer.score_relationship;
  const riskControl = result === "暂缓" ? Math.max(0, customer.score_risk_control - 12) : customer.score_risk_control;
  const payment = result === "成交" ? Math.min(100, customer.score_payment + 8) : customer.score_payment;

  await env.DB.prepare(`
    UPDATE customers
    SET last_follow_up = ?, next_follow_up = ?, stage = ?, score_activity = ?,
        score_intent = ?, score_relationship = ?, score_risk_control = ?,
        score_payment = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(date, input.nextFollowUp || customer.next_follow_up, nextStage, activity, intent, relationship, riskControl, payment, input.customerId).run();

  return json({ followup: { id, customerId: input.customerId, date, method, result, content: input.content || "", owner: user.name } }, 201);
}

async function saveDailyReport({ request, env }, user) {
  const input = await request.json();
  const today = new Date().toISOString().slice(0, 10);
  const reportDate = normalizeDate(input.reportDate || today, today);
  const existing = await env.DB.prepare("SELECT id FROM daily_reports WHERE report_date = ? AND user_id = ?")
    .bind(reportDate, user.id).first();
  const id = existing?.id || crypto.randomUUID();
  const values = [
    id,
    reportDate,
    user.id,
    user.name,
    wholeNumber(input.crmCount),
    wholeNumber(input.sampleCount),
    wholeNumber(input.quoteCount),
    wholeNumber(input.oldVisitCount),
    wholeNumber(input.over3Count),
    wholeNumber(input.over3PhoneCount),
    wholeNumber(input.over3WechatCount),
    wholeNumber(input.over3IntentCount),
    wholeNumber(input.over3DealCount),
    wholeNumber(input.dealCount),
    String(input.notes || "").trim()
  ];

  await env.DB.prepare(`
    INSERT INTO daily_reports (
      id, report_date, user_id, owner, crm_count, sample_count, quote_count,
      old_visit_count, over3_count, over3_phone_count, over3_wechat_count,
      over3_intent_count, over3_deal_count, deal_count, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_date, user_id) DO UPDATE SET
      owner = excluded.owner,
      crm_count = excluded.crm_count,
      sample_count = excluded.sample_count,
      quote_count = excluded.quote_count,
      old_visit_count = excluded.old_visit_count,
      over3_count = excluded.over3_count,
      over3_phone_count = excluded.over3_phone_count,
      over3_wechat_count = excluded.over3_wechat_count,
      over3_intent_count = excluded.over3_intent_count,
      over3_deal_count = excluded.over3_deal_count,
      deal_count = excluded.deal_count,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP
  `).bind(...values).run();

  const report = await env.DB.prepare("SELECT * FROM daily_reports WHERE report_date = ? AND user_id = ?")
    .bind(reportDate, user.id).first();
  return json({ report: mapDailyReport(report) });
}

async function listUsers({ env }, user) {
  if (!isAdminUser(user)) return json({ error: "只有管理员可以管理账号" }, 403);
  const result = await env.DB.prepare("SELECT id, name, account, role, created_at FROM users ORDER BY created_at DESC").all();
  return json({ users: result.results });
}

async function createUser({ request, env }, user) {
  if (!isAdminUser(user)) return json({ error: "只有管理员可以创建子账号" }, 403);
  const input = await request.json();
  const account = String(input.account || "").trim();
  const name = String(input.name || "").trim();
  const password = String(input.password || "").trim();
  const role = String(input.role || "销售").trim();
  if (!account || !name || !password) return json({ error: "姓名、账号和密码不能为空" }, 400);
  if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);

  const exists = await env.DB.prepare("SELECT id FROM users WHERE account = ?").bind(account).first();
  if (exists) return json({ error: "账号已存在" }, 409);

  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, name, account, password_hash, role) VALUES (?, ?, ?, ?, ?)")
    .bind(id, name, account, await sha256(password), role).run();
  return json({ user: { id, name, account, role } }, 201);
}

async function resetUserPassword({ request, env }, user, userId) {
  if (!isAdminUser(user)) return json({ error: "只有管理员可以重置子账号密码" }, 403);
  if (!userId) return json({ error: "缺少账号 ID" }, 400);
  if (userId === user.id) return json({ error: "不能在这里重置当前管理员账号密码" }, 400);

  const input = await request.json();
  const password = String(input.password || "").trim();
  if (password.length < 6) return json({ error: "新密码至少 6 位" }, 400);

  const target = await env.DB.prepare("SELECT id, role FROM users WHERE id = ?").bind(userId).first();
  if (!target) return json({ error: "账号不存在" }, 404);
  if (isAdminUser(target)) return json({ error: "不能重置管理员账号密码" }, 400);

  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
    .bind(await sha256(password), userId).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  return json({ ok: true });
}

async function deleteUser({ env }, user, userId) {
  if (!isAdminUser(user)) return json({ error: "只有管理员可以删除子账号" }, 403);
  if (!userId) return json({ error: "缺少账号 ID" }, 400);
  if (userId === user.id) return json({ error: "不能删除当前登录的管理员账号" }, 400);

  const target = await env.DB.prepare("SELECT id, account, role FROM users WHERE id = ?").bind(userId).first();
  if (!target) return json({ error: "账号不存在" }, 404);
  if (isAdminUser(target)) return json({ error: "不能删除管理员账号" }, 400);

  const customerCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM customers WHERE created_by = ?").bind(userId).first();
  if (Number(customerCount?.count || 0) > 0) {
    return json({ error: "该账号名下已有客户，不能直接删除。请先由管理员接管或转移客户。" }, 409);
  }

  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  return json({ ok: true });
}

function mapCustomer(row) {
  const customer = {
    id: row.id,
    name: row.name,
    companyName: row.company_name || "",
    preferredStyle: row.preferred_style || "",
    industry: row.industry,
    region: row.region,
    owner: row.owner,
    createdBy: row.created_by || "",
    deletedAt: row.deleted_at || "",
    stage: row.stage,
    budget: row.budget,
    contact: row.contact,
    phone: row.phone,
    source: row.source,
    tags: safeJson(row.tags, []),
    nextFollowUp: row.next_follow_up,
    lastFollowUp: row.last_follow_up,
    scores: {
      value: row.score_value,
      intent: row.score_intent,
      activity: row.score_activity,
      relationship: row.score_relationship,
      payment: row.score_payment,
      riskControl: row.score_risk_control
    }
  };
  customer.score = calcScore(customer);
  customer.tier = tier(customer.score);
  return customer;
}

function mapFollowup(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    date: row.followup_date,
    method: row.method,
    result: row.result,
    content: row.content,
    owner: row.owner
  };
}

function mapDailyReport(row) {
  return {
    id: row.id,
    reportDate: row.report_date,
    userId: row.user_id,
    owner: row.owner,
    crmCount: row.crm_count,
    sampleCount: row.sample_count,
    quoteCount: row.quote_count,
    oldVisitCount: row.old_visit_count,
    over3Count: row.over3_count,
    over3PhoneCount: row.over3_phone_count,
    over3WechatCount: row.over3_wechat_count,
    over3IntentCount: row.over3_intent_count,
    over3DealCount: row.over3_deal_count,
    dealCount: row.deal_count,
    notes: row.notes || "",
    updatedAt: row.updated_at || ""
  };
}

function calcScore(customer) {
  return Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + customer.scores[key] * weight, 0));
}

function tier(score) {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

function isAdminUser(user) {
  return user?.role === "管理员" || user?.role === "admin";
}

function canAccessCustomer(user, customer) {
  return isAdminUser(user) || customer.created_by === user.id || customer.owner === user.name;
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value || 50)));
}

function wholeNumber(value) {
  return Math.max(0, Math.floor(Number(value || 0)));
}

function normalizeStage(stage) {
  return ["新线索", "已联系", "需求确认", "报价中", "成交", "暂缓"].includes(stage) ? stage : "新线索";
}

function normalizeDate(value, fallback) {
  const text = String(value || "").trim().replaceAll("/", "-");
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(text) ? text.split("-").map((part, index) => index ? part.padStart(2, "0") : part).join("-") : fallback;
}

function normalizeHeader(text) {
  return String(text || "").trim().replace(/\s+/g, "").toLowerCase();
}

function pick(record, ...keys) {
  for (const key of keys) {
    const value = record[normalizeHeader(key)];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\ufeff/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows.filter(items => items.some(item => String(item || "").trim()));
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  const target = `${name}=`;
  return cookies.split(";").map(item => item.trim()).find(item => item.startsWith(target))?.slice(target.length) || "";
}

function cookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
