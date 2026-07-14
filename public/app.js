const state = {
  user: null,
  customers: [],
  followups: [],
  selectedId: null,
  view: "dashboard"
};

const titles = {
  dashboard: ["仪表盘", "自动识别客户价值、跟进优先级和流失风险。"],
  customers: ["客户管理", "维护客户画像，查看雷达评分，并快速记录销售跟进。"],
  followups: ["销售跟进", "沉淀沟通记录，自动提升活跃度和成交意向。"],
  segments: ["客户分层看板", "A 重点跟进，B 持续培育，C 低频维护，D 重新判断。"]
};

const dims = [
  ["value", "客户价值"],
  ["intent", "成交意向"],
  ["activity", "活跃度"],
  ["relationship", "关系深度"],
  ["payment", "回款健康"],
  ["riskControl", "风险控制"]
];

function $(selector) {
  return document.querySelector(selector);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(dateText) {
  const one = new Date(dateText + "T00:00:00");
  const now = new Date(today() + "T00:00:00");
  return Math.ceil((one - now) / 86400000);
}

function tierBadge(tier) {
  return `<span class="tier tier-${tier.toLowerCase()}">${tier} 类</span>`;
}

function customerById(id) {
  return state.customers.find(customer => customer.id === id);
}

function showView(view) {
  state.view = view;
  $(".view:not(.hidden)")?.classList.add("hidden");
  $("#" + view).classList.remove("hidden");
  document.querySelectorAll(".nav").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  $("#title").textContent = titles[view][0];
  $("#subtitle").textContent = titles[view][1];
  if (view === "customers") setTimeout(() => drawRadar(customerById(state.selectedId)), 0);
}

async function loadState() {
  const data = await api("/api/state");
  state.user = data.user;
  state.customers = data.customers;
  state.followups = data.followups;
  state.selectedId ||= state.customers[0]?.id;
  render();
}

function render() {
  $("#user-name").textContent = state.user.name;
  $("#user-role").textContent = state.user.role;
  renderStats();
  renderDashboard();
  renderCustomers();
  renderDetail();
  renderFollowups();
  renderSegments();
}

function renderStats() {
  $("#stat-total").textContent = state.customers.length;
  $("#stat-a").textContent = state.customers.filter(c => c.tier === "A").length;
  $("#stat-due").textContent = state.customers.filter(c => daysUntil(c.nextFollowUp) <= 0).length;
  $("#stat-risk").textContent = state.customers.filter(c => c.scores.riskControl < 45).length;
}

function renderDashboard() {
  const sorted = [...state.customers].sort((a, b) => b.score - a.score);
  $("#top-customers").innerHTML = sorted.slice(0, 6).map(customer => `
    <tr>
      <td><strong>${customer.name}</strong><div class="subtle">${customer.industry} · ${customer.region}</div></td>
      <td><span class="stage">${customer.stage}</span></td>
      <td>${customer.owner}</td>
      <td><strong>${customer.score}</strong></td>
      <td>${tierBadge(customer.tier)}</td>
    </tr>
  `).join("");

  const stages = ["新线索", "已联系", "需求确认", "报价中", "成交", "暂缓"];
  const max = Math.max(...stages.map(stage => state.customers.filter(customer => customer.stage === stage).length), 1);
  $("#funnel").innerHTML = stages.map(stage => {
    const count = state.customers.filter(customer => customer.stage === stage).length;
    return `<div class="funnel-row"><span>${stage}</span><div class="track"><span style="width:${count / max * 100}%"></span></div><strong>${count}</strong></div>`;
  }).join("");

  const risks = sorted.filter(customer => customer.scores.riskControl < 60 || daysUntil(customer.nextFollowUp) < 0).slice(0, 5);
  $("#risk-list").innerHTML = risks.length ? risks.map(customer => `
    <div class="item"><div class="item-top"><strong>${customer.name}</strong><span>${tierBadge(customer.tier)}</span></div><p>${riskText(customer)}</p></div>
  `).join("") : `<p class="subtle">暂无高风险客户。</p>`;
}

function renderCustomers() {
  const keyword = $("#search").value.trim().toLowerCase();
  const tier = $("#tier-filter").value;
  const stage = $("#stage-filter").value;
  let list = state.customers.filter(customer => {
    const haystack = [customer.name, customer.industry, customer.region, customer.owner, customer.stage, ...customer.tags].join(" ").toLowerCase();
    return (!keyword || haystack.includes(keyword)) && (!tier || customer.tier === tier) && (!stage || customer.stage === stage);
  }).sort((a, b) => b.score - a.score);

  $("#customer-table").innerHTML = list.map(customer => `
    <tr>
      <td>
        <div class="name-cell">
          <strong>${customer.name}</strong>
          <span class="subtle">${customer.industry} · ${customer.region} · ${customer.contact}</span>
          <span class="tags">${customer.tags.map(tag => `<span class="tag">${tag}</span>`).join("")}</span>
        </div>
      </td>
      <td><span class="stage">${customer.stage}</span></td>
      <td>${customer.budget} 万</td>
      <td>${customer.nextFollowUp}</td>
      <td><div class="score">${customer.score}</div><div class="bar"><div class="fill" style="width:${customer.score}%"></div></div></td>
      <td><button class="btn" data-select="${customer.id}">查看</button></td>
    </tr>
  `).join("");

  document.querySelectorAll("[data-select]").forEach(button => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.select;
      renderDetail();
    });
  });

  $("[name='customerId']").innerHTML = state.customers.map(customer => `<option value="${customer.id}" ${customer.id === state.selectedId ? "selected" : ""}>${customer.name}</option>`).join("");
  if (!$("[name='nextFollowUp']").value) $("[name='nextFollowUp']").value = today();
}

function renderDetail() {
  const customer = customerById(state.selectedId) || state.customers[0];
  if (!customer) return;
  state.selectedId = customer.id;
  $("#detail").innerHTML = `
    <div class="profile-head">
      <div>
        <h2>${customer.name}</h2>
        <p class="subtle">${customer.industry} · ${customer.region} · ${customer.source}</p>
        <div class="tags">${tierBadge(customer.tier)} <span class="stage">${customer.stage}</span></div>
      </div>
      <div><div class="score">${customer.score}</div><div class="subtle">综合评分</div></div>
    </div>
    <div class="kv">
      <div><span>负责人</span><strong>${customer.owner}</strong></div>
      <div><span>年预算</span><strong>${customer.budget} 万</strong></div>
      <div><span>联系人</span><strong>${customer.contact}</strong></div>
      <div><span>联系方式</span><strong>${customer.phone}</strong></div>
      <div><span>最近跟进</span><strong>${customer.lastFollowUp}</strong></div>
      <div><span>下次跟进</span><strong>${customer.nextFollowUp}</strong></div>
    </div>
    <canvas id="radar" width="360" height="360"></canvas>
  `;
  drawRadar(customer);
}

function drawRadar(customer) {
  const canvas = $("#radar");
  if (!canvas || !customer) return;
  const ctx = canvas.getContext("2d");
  const cx = 180;
  const cy = 180;
  const r = 112;
  ctx.clearRect(0, 0, 360, 360);
  ctx.font = "13px Microsoft YaHei, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let ring = 1; ring <= 5; ring++) {
    ctx.beginPath();
    dims.forEach((_, index) => {
      const p = point(cx, cy, r * ring / 5, index);
      index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.strokeStyle = "#d9dee7";
    ctx.stroke();
  }
  dims.forEach(([, label], index) => {
    const p = point(cx, cy, r + 32, index);
    ctx.fillStyle = "#475569";
    ctx.fillText(label, p.x, p.y);
  });
  ctx.beginPath();
  dims.forEach(([key], index) => {
    const p = point(cx, cy, r * customer.scores[key] / 100, index);
    index ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(15, 118, 110, .22)";
  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 3;
  ctx.fill();
  ctx.stroke();
}

function point(cx, cy, radius, index) {
  const angle = -Math.PI / 2 + Math.PI * 2 * index / dims.length;
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

function riskText(customer) {
  const due = daysUntil(customer.nextFollowUp);
  if (customer.scores.riskControl < 45) return "风险控制分偏低，建议复盘竞品、价格异议和项目停滞原因。";
  if (due < 0) return `已超期 ${Math.abs(due)} 天未跟进，建议立即联系。`;
  return "近期需要关注阶段推进，避免报价后无反馈。";
}

function renderFollowups() {
  $("#followup-list").innerHTML = state.followups.map(followup => {
    const customer = customerById(followup.customerId);
    return `<div class="item"><div class="item-top"><strong>${customer?.name || "未知客户"}</strong><span>${followup.date} · ${followup.method} · ${followup.result}</span></div><p>${followup.content}</p></div>`;
  }).join("");

  $("#priority-list").innerHTML = [...state.customers].sort((a, b) => {
    const pa = (daysUntil(a.nextFollowUp) <= 0 ? 100 : 0) + (100 - a.scores.riskControl) + a.score / 10;
    const pb = (daysUntil(b.nextFollowUp) <= 0 ? 100 : 0) + (100 - b.scores.riskControl) + b.score / 10;
    return pb - pa;
  }).slice(0, 6).map(customer => `<div class="item"><div class="item-top"><strong>${customer.name}</strong><span>${customer.nextFollowUp}</span></div><p>${riskText(customer)}</p></div>`).join("");
}

function renderSegments() {
  const groups = { A: [], B: [], C: [], D: [] };
  state.customers.forEach(customer => groups[customer.tier].push(customer));
  const names = { A: "A 类重点", B: "B 类培育", C: "C 类维护", D: "D 类观察" };
  $("#board").innerHTML = Object.entries(groups).map(([key, customers]) => `
    <div class="col">
      <div class="panel-head"><h3>${names[key]}</h3>${tierBadge(key)}</div>
      ${customers.sort((a, b) => b.score - a.score).map(customer => `
        <div class="card">
          <strong>${customer.name}</strong>
          <p class="subtle">${customer.industry} · ${customer.owner}<br>评分 ${customer.score} · 下次跟进 ${customer.nextFollowUp}</p>
          <div class="tags">${customer.tags.slice(0, 2).map(tag => `<span class="tag">${tag}</span>`).join("")}</div>
        </div>
      `).join("") || `<p class="subtle">暂无客户</p>`}
    </div>
  `).join("");
}

async function init() {
  const me = await api("/api/me");
  if (me.user) {
    state.user = me.user;
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await loadState();
  }
}

$("#login-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#login-error").textContent = "";
  const form = Object.fromEntries(new FormData(event.target));
  try {
    const data = await api("/api/login", { method: "POST", body: JSON.stringify(form) });
    state.user = data.user;
    $("#login").classList.add("hidden");
    $("#app").classList.remove("hidden");
    await loadState();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  location.reload();
});

document.querySelectorAll(".nav").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
$("#refresh").addEventListener("click", loadState);
$("#open-customer").addEventListener("click", () => $("#customer-dialog").showModal());
$("#close-customer").addEventListener("click", () => $("#customer-dialog").close());
["search", "tier-filter", "stage-filter"].forEach(id => $("#" + id).addEventListener("input", renderCustomers));

$("#customer-form").addEventListener("submit", async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  const data = await api("/api/customers", { method: "POST", body: JSON.stringify(body) });
  state.selectedId = data.customer.id;
  event.target.reset();
  $("#customer-dialog").close();
  await loadState();
  showView("customers");
});

$("#follow-form").addEventListener("submit", async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  await api("/api/followups", { method: "POST", body: JSON.stringify(body) });
  event.target.reset();
  await loadState();
});

init().catch(error => {
  $("#login-error").textContent = error.message;
});
