import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataDir = process.env.DATA_DIR || join(root, "data");
const dbPath = join(dataDir, "db.json");
const port = Number(process.env.PORT || 4173);

const sessions = new Map();

const seed = {
  users: [
    { id: "u1", name: "管理员", account: "admin", passwordHash: sha256("admin123"), role: "管理员" },
    { id: "u2", name: "林晨", account: "linchen", passwordHash: sha256("123456"), role: "销售" },
    { id: "u3", name: "许诺", account: "xunuo", passwordHash: sha256("123456"), role: "销售主管" }
  ],
  customers: [
    {
      id: "c1", name: "杭州云帆智造有限公司", industry: "智能制造", region: "浙江杭州", owner: "林晨",
      stage: "报价中", budget: 280, contact: "周总 / 采购负责人", phone: "138-0000-1024", source: "展会线索",
      tags: ["高预算", "老板关注", "本月决策"], nextFollowUp: "2026-07-15", lastFollowUp: "2026-07-12",
      scores: { value: 92, intent: 86, activity: 78, relationship: 82, payment: 74, riskControl: 68 }
    },
    {
      id: "c2", name: "上海瑞禾连锁商业集团", industry: "连锁零售", region: "上海", owner: "许诺",
      stage: "需求确认", budget: 190, contact: "李经理 / 数字化负责人", phone: "136-0000-8848", source: "老客户转介绍",
      tags: ["多门店", "流程复杂", "需方案"], nextFollowUp: "2026-07-14", lastFollowUp: "2026-07-10",
      scores: { value: 82, intent: 76, activity: 88, relationship: 70, payment: 80, riskControl: 73 }
    },
    {
      id: "c3", name: "苏州科启医疗器械", industry: "医疗器械", region: "江苏苏州", owner: "林晨",
      stage: "已联系", budget: 85, contact: "王主任 / 运营", phone: "139-0000-2211", source: "官网咨询",
      tags: ["价格敏感", "需教育", "竞品对比"], nextFollowUp: "2026-07-16", lastFollowUp: "2026-07-06",
      scores: { value: 58, intent: 62, activity: 55, relationship: 48, payment: 66, riskControl: 52 }
    },
    {
      id: "c4", name: "广州越海供应链", industry: "物流供应链", region: "广东广州", owner: "赵言",
      stage: "暂缓", budget: 130, contact: "陈总 / 总经理", phone: "137-0000-9090", source: "渠道推荐",
      tags: ["项目暂停", "竞品介入", "需高层维护"], nextFollowUp: "2026-07-13", lastFollowUp: "2026-06-21",
      scores: { value: 76, intent: 44, activity: 30, relationship: 64, payment: 58, riskControl: 28 }
    }
  ],
  followups: [
    { id: "f1", customerId: "c1", date: "2026-07-12", method: "会议", result: "报价中", content: "客户确认 3 个部门参与试点，要求补充实施排期和售后响应承诺。", owner: "林晨" },
    { id: "f2", customerId: "c2", date: "2026-07-10", method: "电话", result: "需求确认", content: "客户希望先看门店经营数据看板案例，下周安排方案演示。", owner: "许诺" }
  ]
};

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function ensureDb() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath)) await writeFile(dbPath, JSON.stringify(seed, null, 2), "utf8");
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function writeDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2), "utf8");
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
  });
}

function currentUser(req) {
  const token = parseCookies(req).crm_session;
  return token ? sessions.get(token) : null;
}

function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) {
    send(res, 401, { error: "未登录" });
    return null;
  }
  return user;
}

const weights = { value: .25, intent: .25, activity: .15, relationship: .15, payment: .10, riskControl: .10 };
function calcScore(customer) {
  return Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + customer.scores[key] * weight, 0));
}

function tier(score) {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

function todayText() {
  return new Date().toISOString().slice(0, 10);
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    return send(res, 200, { ok: true, service: "customer-radar-crm" });
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const { account, password } = await readBody(req);
    const db = await readDb();
    const user = db.users.find(item => item.account === account && item.passwordHash === sha256(password || ""));
    if (!user) return send(res, 401, { error: "账号或密码错误" });
    const token = randomUUID();
    sessions.set(token, { id: user.id, name: user.name, account: user.account, role: user.role });
    return send(res, 200, { user: sessions.get(token) }, { "set-cookie": `crm_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax` });
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const token = parseCookies(req).crm_session;
    if (token) sessions.delete(token);
    return send(res, 200, { ok: true }, { "set-cookie": "crm_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax" });
  }

  if (req.method === "GET" && pathname === "/api/me") {
    return send(res, 200, { user: currentUser(req) });
  }

  const user = requireUser(req, res);
  if (!user) return;

  if (req.method === "GET" && pathname === "/api/state") {
    const db = await readDb();
    const customers = db.customers.map(customer => ({ ...customer, score: calcScore(customer), tier: tier(calcScore(customer)) }));
    return send(res, 200, { user, customers, followups: db.followups });
  }

  if (req.method === "POST" && pathname === "/api/customers") {
    const db = await readDb();
    const input = await readBody(req);
    const customer = {
      id: randomUUID(),
      name: input.name,
      industry: input.industry,
      region: input.region,
      owner: input.owner || user.name,
      stage: input.stage || "新线索",
      budget: Number(input.budget || 0),
      contact: input.contact || "",
      phone: input.phone || "",
      source: input.source || "",
      tags: String(input.tags || "").split(/[，,]/).map(item => item.trim()).filter(Boolean),
      nextFollowUp: input.nextFollowUp || todayText(),
      lastFollowUp: input.lastFollowUp || todayText(),
      scores: {
        value: Number(input.value || 50),
        intent: Number(input.intent || 50),
        activity: Number(input.activity || 50),
        relationship: Number(input.relationship || 50),
        payment: Number(input.payment || 50),
        riskControl: Number(input.riskControl || 50)
      }
    };
    db.customers.unshift(customer);
    await writeDb(db);
    return send(res, 201, { customer: { ...customer, score: calcScore(customer), tier: tier(calcScore(customer)) } });
  }

  if (req.method === "POST" && pathname === "/api/followups") {
    const db = await readDb();
    const input = await readBody(req);
    const customer = db.customers.find(item => item.id === input.customerId);
    if (!customer) return send(res, 404, { error: "客户不存在" });
    const followup = {
      id: randomUUID(),
      customerId: input.customerId,
      date: todayText(),
      method: input.method || "电话",
      result: input.result || "有意向",
      content: input.content || "",
      owner: user.name
    };
    db.followups.unshift(followup);
    customer.lastFollowUp = followup.date;
    customer.nextFollowUp = input.nextFollowUp || customer.nextFollowUp;
    customer.stage = input.result === "有意向" ? customer.stage : input.result;
    customer.scores.activity = Math.min(100, customer.scores.activity + 12);
    if (["需求确认", "报价中", "成交"].includes(input.result)) customer.scores.intent = Math.min(100, customer.scores.intent + 8);
    if (["拜访", "会议"].includes(input.method)) customer.scores.relationship = Math.min(100, customer.scores.relationship + 6);
    if (input.result === "暂缓") customer.scores.riskControl = Math.max(0, customer.scores.riskControl - 12);
    if (input.result === "成交") customer.scores.payment = Math.min(100, customer.scores.payment + 8);
    await writeDb(db);
    return send(res, 201, { followup });
  }

  send(res, 404, { error: "接口不存在" });
}

async function serveStatic(req, res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = join(publicDir, file);
  if (!target.startsWith(publicDir)) return send(res, 403, "Forbidden");
  try {
    const data = await readFile(target);
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    res.writeHead(200, { "content-type": types[extname(target)] || "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, "Not found");
  }
}

await ensureDb();

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url.pathname);
    else await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    send(res, 500, { error: "服务器错误" });
  }
}).listen(port, () => {
  console.log(`客户价值雷达 CRM 已启动: http://localhost:${port}`);
});
