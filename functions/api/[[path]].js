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
    if (path === "customers" && method === "POST") return createCustomer(context, user);
    if (path === "followups" && method === "POST") return createFollowup(context, user);

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
  const customersResult = await env.DB.prepare("SELECT * FROM customers ORDER BY created_at DESC").all();
  const followupsResult = await env.DB.prepare("SELECT * FROM followups ORDER BY followup_date DESC, created_at DESC").all();
  return json({
    user,
    customers: customersResult.results.map(mapCustomer),
    followups: followupsResult.results.map(mapFollowup)
  });
}

async function createCustomer({ request, env }, user) {
  const input = await request.json();
  const id = crypto.randomUUID();
  const tags = String(input.tags || "").split(/[，,]/).map(item => item.trim()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);

  await env.DB.prepare(`
    INSERT INTO customers (
      id, name, industry, region, owner, stage, budget, contact, phone, source, tags,
      next_follow_up, last_follow_up, score_value, score_intent, score_activity,
      score_relationship, score_payment, score_risk_control
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.name || "",
    input.industry || "",
    input.region || "",
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
    clamp(input.riskControl)
  ).run();

  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
  return json({ customer: mapCustomer(customer) }, 201);
}

async function createFollowup({ request, env }, user) {
  const input = await request.json();
  const customer = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(input.customerId || "").first();
  if (!customer) return json({ error: "客户不存在" }, 404);

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

function mapCustomer(row) {
  const customer = {
    id: row.id,
    name: row.name,
    industry: row.industry,
    region: row.region,
    owner: row.owner,
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

function calcScore(customer) {
  return Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + customer.scores[key] * weight, 0));
}

function tier(score) {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value || 50)));
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
