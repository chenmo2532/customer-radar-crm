const state = {
  user: null,
  customers: [],
  deletedCustomers: [],
  followups: [],
  dailyReports: [],
  users: [],
  selectedId: null,
  editingCustomerId: null,
  view: "dashboard"
};

const titles = {
  dashboard: ["仪表盘", "管理员看全部数据；子账号只看自己创建或负责的客户。"],
  customers: ["客户管理", "维护客户画像，查看雷达评分，并快速记录销售跟进。"],
  followups: ["销售跟进", "沉淀沟通记录，自动提升活跃度和成交意向。"],
  reports: ["工作总结", "记录每日工作量，沉淀个人和团队销售动作数据。"],
  segments: ["客户分层看板", "A 重点跟进，B 持续培育，C 低频维护，D 重新判断。"],
  accounts: ["账号管理", "管理员创建子账号；子账号登录后只能看到自己的客户资料。"]
};

const dims = [
  ["value", "客户价值"],
  ["intent", "成交意向"],
  ["activity", "活跃度"],
  ["relationship", "关系深度"],
  ["payment", "回款健康"],
  ["riskControl", "风险控制"]
];

const pipelineStages = ["新线索", "已联系", "需求确认", "报价中", "成交", "暂缓"];
const activePipelineStages = pipelineStages.filter(stage => stage !== "暂缓");

function $(selector) {
  return document.querySelector(selector);
}

function isAdmin() {
  return state.user?.role === "管理员" || state.user?.role === "admin";
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

function daysSince(dateText) {
  return -daysUntil(dateText);
}

function tierBadge(tier) {
  return `<span class="tier tier-${tier.toLowerCase()}">${tier} 类</span>`;
}

function customerById(id) {
  return state.customers.find(customer => customer.id === id);
}

function showView(view) {
  if (view === "accounts" && !isAdmin()) return;
  state.view = view;
  document.querySelectorAll(".view").forEach(section => section.classList.toggle("hidden", section.id !== view));
  document.querySelectorAll(".nav").forEach(button => button.classList.toggle("active", button.dataset.view === view));
  $("#title").textContent = titles[view][0];
  $("#subtitle").textContent = titles[view][1];
  if (view === "customers") setTimeout(() => drawRadar(customerById(state.selectedId)), 0);
  if (view === "reports") prepareReportForm();
  if (view === "accounts") loadUsers();
}

async function loadState() {
  const data = await api("/api/state");
  state.user = data.user;
  state.customers = data.customers;
  state.deletedCustomers = data.deletedCustomers || [];
  state.followups = data.followups;
  state.dailyReports = data.dailyReports || [];
  state.selectedId = state.customers.some(customer => customer.id === state.selectedId)
    ? state.selectedId
    : state.customers[0]?.id;
  render();
}

function render() {
  $("#user-name").textContent = state.user.name;
  $("#user-role").textContent = state.user.role;
  document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin()));
  renderStats();
  renderDashboard();
  renderCustomers();
  renderDetail();
  renderFollowups();
  renderReports();
  renderSegments();
}

function renderStats() {
  $("#stat-total").textContent = state.customers.length;
  $("#stat-a").textContent = state.customers.filter(c => c.tier === "A").length;
  $("#stat-due").textContent = state.customers.filter(c => daysUntil(c.nextFollowUp) <= 0).length;
  $("#stat-conversion").textContent = `${dealRate()}%`;
}

function renderDashboard() {
  const sorted = [...state.customers].sort((a, b) => b.score - a.score);
  renderTodoList();
  renderHotList();
  renderOwnerStats();
  renderStalledList();
  $("#top-customers").innerHTML = sorted.slice(0, 6).map(customer => `
    <tr>
      <td><strong>${customer.name}</strong><div class="subtle">${customer.industry} · ${customer.region}</div></td>
      <td><span class="stage">${customer.stage}</span></td>
      <td>${customer.owner}</td>
      <td><strong>${customer.score}</strong></td>
      <td>${tierBadge(customer.tier)}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">暂无客户</td></tr>`;

  const max = Math.max(...pipelineStages.map(stage => state.customers.filter(customer => customer.stage === stage).length), 1);
  $("#funnel").innerHTML = pipelineStages.map(stage => {
    const count = state.customers.filter(customer => customer.stage === stage).length;
    const rate = stage === "暂缓" ? "暂缓" : `${stageConversionRate(stage)}%`;
    return `<div class="funnel-row"><span>${stage}</span><div class="track"><span style="width:${count / max * 100}%"></span></div><strong>${count}</strong><em>${rate}</em></div>`;
  }).join("");

  const risks = sorted.filter(customer => customer.scores.riskControl < 60 || daysUntil(customer.nextFollowUp) < 0).slice(0, 5);
  $("#risk-list").innerHTML = risks.length ? risks.map(customer => `
    <div class="item"><div class="item-top"><strong>${customer.name}</strong><span>${tierBadge(customer.tier)}</span></div><p>${riskText(customer)}</p></div>
  `).join("") : `<p class="subtle">暂无高风险客户。</p>`;
}

function renderTodoList() {
  const list = [...state.customers].filter(customer => daysUntil(customer.nextFollowUp) <= 0 && customer.stage !== "成交")
    .sort((a, b) => daysUntil(a.nextFollowUp) - daysUntil(b.nextFollowUp));
  $("#todo-list").innerHTML = list.slice(0, 8).map(customer => {
    const due = daysUntil(customer.nextFollowUp);
    const label = due < 0 ? `逾期 ${Math.abs(due)} 天` : "今天跟进";
    return `<div class="item alert-item"><div class="item-top"><strong>${customer.name}</strong><span>${label}</span></div><p>${customer.owner} · ${customer.stage} · 下次跟进 ${customer.nextFollowUp}</p></div>`;
  }).join("") || `<p class="subtle">暂无逾期或今日待办客户。</p>`;
}

function renderHotList() {
  const list = [...state.customers].filter(customer => customer.stage !== "成交" && customer.stage !== "暂缓")
    .sort((a, b) => hotScore(b) - hotScore(a));
  $("#hot-list").innerHTML = list.slice(0, 6).map(customer => `
    <div class="item"><div class="item-top"><strong>${customer.name}</strong><span>${customer.stage} · ${customer.scores.intent} 分</span></div><p>${customer.owner} · 预算 ${customer.budget} 万 · ${customer.preferredStyle || customer.companyName || "暂无款式信息"}</p></div>
  `).join("") || `<p class="subtle">暂无可判断的快成交客户。</p>`;
}

function renderStalledList() {
  const list = [...state.customers].filter(customer => customer.stage !== "成交" && (customer.stage === "暂缓" || daysSince(customer.lastFollowUp) >= 7 || daysUntil(customer.nextFollowUp) < -3))
    .sort((a, b) => stalledScore(b) - stalledScore(a));
  $("#stalled-list").innerHTML = list.slice(0, 8).map(customer => `
    <div class="item alert-item"><div class="item-top"><strong>${customer.name}</strong><span>${customer.stage}</span></div><p>${customer.owner} · ${stallReason(customer)}</p></div>
  `).join("") || `<p class="subtle">暂无明显卡住客户。</p>`;
}

function renderOwnerStats() {
  const owners = ownerStats();
  $("#owner-stats").innerHTML = owners.map(owner => `
    <tr>
      <td><strong>${owner.name}</strong></td>
      <td>${owner.followups}</td>
      <td>${owner.customers}</td>
      <td>${owner.deals}</td>
      <td>${owner.highTouchNoDeal}</td>
    </tr>
  `).join("") || `<tr><td colspan="5">暂无跟进统计</td></tr>`;
}

function renderCustomers() {
  const keyword = $("#search").value.trim().toLowerCase();
  const tier = $("#tier-filter").value;
  const stage = $("#stage-filter").value;
  const list = state.customers.filter(customer => {
    const haystack = [customer.name, customer.companyName, customer.preferredStyle, customer.industry, customer.region, customer.owner, customer.stage, ...customer.tags].join(" ").toLowerCase();
    return (!keyword || haystack.includes(keyword)) && (!tier || customer.tier === tier) && (!stage || customer.stage === stage);
  }).sort((a, b) => b.score - a.score);

  $("#customer-table").innerHTML = list.map(customer => `
    <tr>
      <td>
        <div class="name-cell">
          <strong>${customer.name}</strong>
          <span class="subtle">${customer.companyName || customer.industry} · ${customer.preferredStyle || customer.region} · ${customer.contact}</span>
          <span class="tags">${customer.tags.map(tag => `<span class="tag">${tag}</span>`).join("")}</span>
        </div>
      </td>
      <td><span class="stage">${customer.stage}</span></td>
      <td>${customer.budget} 万</td>
      <td>${customer.nextFollowUp}</td>
      <td><div class="score">${customer.score}</div><div class="bar"><div class="fill" style="width:${customer.score}%"></div></div></td>
      <td>
        <div class="row-actions">
          <button class="btn" data-select="${customer.id}">查看</button>
          <button class="btn" data-edit-customer="${customer.id}">编辑</button>
          <button class="btn danger" data-delete-customer="${customer.id}" data-customer-name="${customer.name}">删除</button>
        </div>
      </td>
    </tr>
  `).join("") || `<tr><td colspan="6">暂无客户，点击右上角新增客户。</td></tr>`;

  document.querySelectorAll("[data-select]").forEach(button => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.select;
      renderDetail();
    });
  });
  bindEditCustomerButtons();
  bindDeleteCustomerButtons();

  $("[name='customerId']").innerHTML = state.customers.map(customer => `<option value="${customer.id}" ${customer.id === state.selectedId ? "selected" : ""}>${customer.name}</option>`).join("");
  if (!$("[name='nextFollowUp']").value) $("[name='nextFollowUp']").value = today();
}

function renderDetail() {
  const customer = customerById(state.selectedId) || state.customers[0];
  if (!customer) {
    $("#detail").innerHTML = `<h2>暂无客户</h2><p class="subtle">新增客户后可查看画像和雷达评分。</p>`;
    return;
  }
  state.selectedId = customer.id;
  $("#detail").innerHTML = `
    <div class="profile-head">
      <div>
        <h2>${customer.name}</h2>
        <p class="subtle">${customer.industry} · ${customer.region} · ${customer.source}</p>
        <div class="tags">${tierBadge(customer.tier)} <span class="stage">${customer.stage}</span></div>
      </div>
      <div class="profile-actions">
        <button class="btn" data-edit-customer="${customer.id}">编辑资料</button>
        <div><div class="score">${customer.score}</div><div class="subtle">综合评分</div></div>
      </div>
    </div>
    <div class="kv">
      <div><span>负责人</span><strong>${customer.owner}</strong></div>
      <div><span>年预算</span><strong>${customer.budget} 万</strong></div>
      <div><span>公司名称</span><strong>${customer.companyName || "未填写"}</strong></div>
      <div><span>意向款式</span><strong>${customer.preferredStyle || "未填写"}</strong></div>
      <div><span>联系人</span><strong>${customer.contact}</strong></div>
      <div><span>联系方式</span><strong>${customer.phone}</strong></div>
      <div><span>最近跟进</span><strong>${customer.lastFollowUp}</strong></div>
      <div><span>下次跟进</span><strong>${customer.nextFollowUp}</strong></div>
    </div>
    <canvas id="radar" width="360" height="360"></canvas>
  `;
  bindEditCustomerButtons();
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
  }).join("") || `<p class="subtle">暂无跟进记录。</p>`;

  $("#priority-list").innerHTML = [...state.customers].sort((a, b) => {
    const pa = (daysUntil(a.nextFollowUp) <= 0 ? 100 : 0) + (100 - a.scores.riskControl) + a.score / 10;
    const pb = (daysUntil(b.nextFollowUp) <= 0 ? 100 : 0) + (100 - b.scores.riskControl) + b.score / 10;
    return pb - pa;
  }).slice(0, 6).map(customer => `<div class="item"><div class="item-top"><strong>${customer.name}</strong><span>${customer.nextFollowUp}</span></div><p>${riskText(customer)}</p></div>`).join("") || `<p class="subtle">暂无客户。</p>`;

  const reminders = [...state.customers].filter(customer => customer.stage !== "成交")
    .sort((a, b) => daysUntil(a.nextFollowUp) - daysUntil(b.nextFollowUp));
  $("#reminder-list").innerHTML = reminders.slice(0, 8).map(customer => {
    const due = daysUntil(customer.nextFollowUp);
    const label = due < 0 ? `已逾期 ${Math.abs(due)} 天` : due === 0 ? "今天" : `${due} 天后`;
    return `<div class="item"><div class="item-top"><strong>${customer.name}</strong><span>${label}</span></div><p>${customer.owner} · ${customer.stage} · 跟进 ${followupCount(customer.id)} 次</p></div>`;
  }).join("") || `<p class="subtle">暂无下次联系提醒。</p>`;
}

function renderReports() {
  const sorted = [...state.dailyReports].sort((a, b) => b.reportDate.localeCompare(a.reportDate) || b.updatedAt.localeCompare(a.updatedAt));
  const todayReport = sorted.find(report => report.reportDate === today() && report.userId === state.user.id);
  $("#today-report-preview").innerHTML = todayReport ? reportCard(todayReport) : `<p class="subtle">今天还没有保存工作总结。</p>`;
  $("#report-table").innerHTML = sorted.map(report => `
    <tr>
      <td>${report.reportDate}</td>
      <td>${report.owner}</td>
      <td>${report.crmCount}</td>
      <td>${report.sampleCount}</td>
      <td>${report.quoteCount}</td>
      <td>${report.oldVisitCount}</td>
      <td>${report.over3Count}</td>
      <td>${report.over3PhoneCount}</td>
      <td>${report.over3WechatCount}</td>
      <td>${report.over3IntentCount}</td>
      <td>${report.over3DealCount}</td>
      <td>${report.dealCount}</td>
    </tr>
  `).join("") || `<tr><td colspan="12">暂无工作总结。</td></tr>`;
}

function reportCard(report) {
  return `
    <div class="item">
      <div class="item-top"><strong>${report.owner} · ${report.reportDate}</strong><span>成交 ${report.dealCount}</span></div>
      <p>CRM入库 ${report.crmCount} 个；发样 ${report.sampleCount} 个；跟进样品报价 ${report.quoteCount} 个；老客回访 ${report.oldVisitCount} 个。</p>
      <p>超3个月老客户联系 ${report.over3Count} 个，其中电话 ${report.over3PhoneCount} 个，已加微信 ${report.over3WechatCount} 个，意向 ${report.over3IntentCount} 个，成交 ${report.over3DealCount} 个。</p>
      ${report.notes ? `<p>${report.notes}</p>` : ""}
    </div>
  `;
}

function prepareReportForm() {
  const form = $("#report-form");
  if (!form) return;
  const fields = form.elements;
  const reportDate = fields.reportDate.value || today();
  fields.reportDate.value = reportDate;
  const report = state.dailyReports.find(item => item.reportDate === reportDate && item.userId === state.user.id);
  if (!report) return;
  fields.crmCount.value = report.crmCount;
  fields.sampleCount.value = report.sampleCount;
  fields.quoteCount.value = report.quoteCount;
  fields.oldVisitCount.value = report.oldVisitCount;
  fields.over3Count.value = report.over3Count;
  fields.over3PhoneCount.value = report.over3PhoneCount;
  fields.over3WechatCount.value = report.over3WechatCount;
  fields.over3IntentCount.value = report.over3IntentCount;
  fields.over3DealCount.value = report.over3DealCount;
  fields.dealCount.value = report.dealCount;
  fields.notes.value = report.notes || "";
}

function followupCount(customerId) {
  return state.followups.filter(followup => followup.customerId === customerId).length;
}

function dealRate() {
  const activeTotal = state.customers.filter(customer => customer.stage !== "暂缓").length;
  if (!activeTotal) return 0;
  const deals = state.customers.filter(customer => customer.stage === "成交").length;
  return Math.round(deals / activeTotal * 100);
}

function stageConversionRate(stage) {
  const stageIndex = activePipelineStages.indexOf(stage);
  const total = state.customers.filter(customer => customer.stage !== "暂缓").length;
  if (stageIndex < 0 || !total) return 0;
  const reached = state.customers.filter(customer => {
    const index = activePipelineStages.indexOf(customer.stage);
    return index >= stageIndex;
  }).length;
  return Math.round(reached / total * 100);
}

function hotScore(customer) {
  const stageWeight = { "报价中": 35, "需求确认": 24, "已联系": 12, "新线索": 5, "暂缓": -30 };
  const dueBoost = daysUntil(customer.nextFollowUp) <= 3 ? 10 : 0;
  return customer.scores.intent + customer.score / 2 + (stageWeight[customer.stage] || 0) + dueBoost;
}

function stalledScore(customer) {
  return (customer.stage === "暂缓" ? 50 : 0) + Math.max(0, daysSince(customer.lastFollowUp)) + Math.max(0, -daysUntil(customer.nextFollowUp) * 2);
}

function stallReason(customer) {
  if (customer.stage === "暂缓") return "阶段已暂缓，需要判断是否继续推进。";
  if (daysUntil(customer.nextFollowUp) < -3) return `下次跟进已逾期 ${Math.abs(daysUntil(customer.nextFollowUp))} 天。`;
  return `最近 ${daysSince(customer.lastFollowUp)} 天没有有效跟进。`;
}

function ownerStats() {
  const map = new Map();
  const ensure = name => {
    if (!map.has(name)) map.set(name, { name, followups: 0, customers: 0, deals: 0, highTouchNoDeal: 0 });
    return map.get(name);
  };
  state.customers.forEach(customer => {
    const owner = ensure(customer.owner || "未分配");
    owner.customers += 1;
    if (customer.stage === "成交") owner.deals += 1;
    if (customer.stage !== "成交" && followupCount(customer.id) >= 3) owner.highTouchNoDeal += 1;
  });
  state.followups.forEach(followup => {
    ensure(followup.owner || "未分配").followups += 1;
  });
  return [...map.values()].sort((a, b) => b.followups - a.followups || b.customers - a.customers);
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

async function loadUsers() {
  if (!isAdmin()) return;
  const data = await api("/api/users");
  state.users = data.users;
  $("#account-table").innerHTML = state.users.map(user => `
    <tr>
      <td>${user.name}</td>
      <td>${user.account}</td>
      <td>${user.role}</td>
      <td>${user.created_at || ""}</td>
      <td>${user.id === state.user.id || user.role === "管理员" ? "-" : `
        <div class="row-actions">
          <button class="btn" data-reset-password="${user.id}" data-user-name="${user.name}">重置密码</button>
          <button class="btn danger" data-delete-user="${user.id}" data-user-name="${user.name}">删除</button>
        </div>
      `}</td>
    </tr>
  `).join("");
  document.querySelectorAll("[data-reset-password]").forEach(button => {
    button.addEventListener("click", async () => {
      const name = button.dataset.userName;
      const password = prompt(`请输入「${name}」的新密码，至少 6 位。`);
      if (password === null) return;
      $("#account-message").textContent = "";
      try {
        await api(`/api/users/${button.dataset.resetPassword}/password`, {
          method: "PUT",
          body: JSON.stringify({ password })
        });
        $("#account-message").textContent = `「${name}」密码已重置，请让对方用新密码重新登录。`;
      } catch (error) {
        $("#account-message").textContent = error.message;
      }
    });
  });
  document.querySelectorAll("[data-delete-user]").forEach(button => {
    button.addEventListener("click", async () => {
      const name = button.dataset.userName;
      if (!confirm(`确定删除子账号「${name}」吗？已有客户的账号不会被删除。`)) return;
      $("#account-message").textContent = "";
      try {
        await api(`/api/users/${button.dataset.deleteUser}`, { method: "DELETE" });
        $("#account-message").textContent = "子账号已删除。";
        await loadUsers();
      } catch (error) {
        $("#account-message").textContent = error.message;
      }
    });
  });
}

function bindEditCustomerButtons() {
  document.querySelectorAll("[data-edit-customer]").forEach(button => {
    button.addEventListener("click", () => openEditCustomerDialog(button.dataset.editCustomer));
  });
}

function bindDeleteCustomerButtons() {
  document.querySelectorAll("[data-delete-customer]").forEach(button => {
    button.addEventListener("click", async () => {
      const name = button.dataset.customerName;
      if (!confirm(`确定删除客户「${name}」吗？删除后可在回收站恢复。`)) return;
      await api(`/api/customers/${button.dataset.deleteCustomer}`, { method: "DELETE" });
      if (state.selectedId === button.dataset.deleteCustomer) state.selectedId = null;
      await loadState();
    });
  });
}

function renderRecycleBin() {
  $("#deleted-list").innerHTML = state.deletedCustomers.map(customer => `
    <div class="item">
      <div class="item-top"><strong>${customer.name}</strong><span>${customer.deletedAt || ""}</span></div>
      <p>${customer.companyName || customer.industry} · ${customer.owner} · ${customer.phone || "无联系方式"}</p>
      <div class="actions"><button class="btn primary" data-restore-customer="${customer.id}">恢复客户</button></div>
    </div>
  `).join("") || `<p class="subtle">回收站暂无客户。</p>`;
  document.querySelectorAll("[data-restore-customer]").forEach(button => {
    button.addEventListener("click", async () => {
      const data = await api(`/api/customers/${button.dataset.restoreCustomer}/restore`, { method: "PUT", body: "{}" });
      state.selectedId = data.customer.id;
      await loadState();
      renderRecycleBin();
    });
  });
}

async function exportCustomers() {
  const response = await fetch("/api/customers/export", { credentials: "same-origin" });
  if (!response.ok) throw new Error("导出失败");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `客户数据-${today()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadImportTemplate() {
  const headers = "客户名称,公司名称,意向款式,行业,地区,负责人,阶段,年预算万元,联系人,联系方式,客户来源,标签,下次跟进,最近跟进,客户价值,成交意向,活跃度,关系深度";
  const sample = `示例客户,示例公司,女装连衣裙,服装,上海,${state.user.name},新线索,10,王经理,13800000000,展会,重点客户,${today()},${today()},60,60,50,50`;
  const blob = new Blob(["\ufeff" + headers + "\r\n" + sample], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "客户导入模板.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function openCreateCustomerDialog() {
  const form = $("#customer-form");
  const fields = form.elements;
  state.editingCustomerId = null;
  form.reset();
  fields.id.value = "";
  fields.owner.value = state.user.name;
  $("#customer-dialog-title").textContent = "新增客户";
  $("#customer-submit").textContent = "保存客户";
  $("#customer-dialog").showModal();
}

function openEditCustomerDialog(id) {
  const customer = customerById(id);
  if (!customer) return;

  const form = $("#customer-form");
  const fields = form.elements;
  state.editingCustomerId = id;
  form.reset();
  fields.id.value = customer.id;
  fields.name.value = customer.name || "";
  fields.companyName.value = customer.companyName || "";
  fields.preferredStyle.value = customer.preferredStyle || "";
  fields.industry.value = customer.industry || "";
  fields.region.value = customer.region || "";
  fields.owner.value = customer.owner || "";
  fields.stage.value = customer.stage || "新线索";
  fields.budget.value = customer.budget || "";
  fields.contact.value = customer.contact || "";
  fields.phone.value = customer.phone || "";
  fields.source.value = customer.source || "";
  fields.tags.value = customer.tags.join(", ");
  fields.nextFollowUp.value = customer.nextFollowUp || "";
  fields.lastFollowUp.value = customer.lastFollowUp || "";
  fields.value.value = customer.scores.value ?? "";
  fields.intent.value = customer.scores.intent ?? "";
  fields.activity.value = customer.scores.activity ?? "";
  fields.relationship.value = customer.scores.relationship ?? "";
  $("#customer-dialog-title").textContent = "修改客户资料";
  $("#customer-submit").textContent = "保存修改";
  $("#customer-dialog").showModal();
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
$("#open-customer").addEventListener("click", openCreateCustomerDialog);
$("#close-customer").addEventListener("click", () => $("#customer-dialog").close());
$("#export-customers").addEventListener("click", async () => {
  try {
    await exportCustomers();
  } catch (error) {
    alert(error.message);
  }
});
$("#open-import").addEventListener("click", () => {
  $("#import-form").reset();
  $("#import-message").textContent = "";
  $("#import-dialog").showModal();
});
$("#close-import").addEventListener("click", () => $("#import-dialog").close());
$("#download-template").addEventListener("click", downloadImportTemplate);
$("#open-recycle").addEventListener("click", () => {
  renderRecycleBin();
  $("#recycle-dialog").showModal();
});
$("#close-recycle").addEventListener("click", () => $("#recycle-dialog").close());
["search", "tier-filter", "stage-filter"].forEach(id => $("#" + id).addEventListener("input", renderCustomers));

$("#customer-form").addEventListener("submit", async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  const id = body.id;
  delete body.id;
  const data = id
    ? await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(body) })
    : await api("/api/customers", { method: "POST", body: JSON.stringify(body) });
  state.selectedId = data.customer.id;
  state.editingCustomerId = null;
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

$("#report-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#report-message").textContent = "";
  try {
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/daily-reports", { method: "POST", body: JSON.stringify(body) });
    $("#report-message").textContent = "工作总结已保存。";
    await loadState();
    prepareReportForm();
  } catch (error) {
    $("#report-message").textContent = error.message;
  }
});

$("#report-form").reportDate.addEventListener("change", event => {
  const selectedDate = event.target.value;
  $("#report-form").reset();
  $("#report-form").reportDate.value = selectedDate;
  prepareReportForm();
});

$("#import-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#import-message").textContent = "正在导入...";
  try {
    const body = Object.fromEntries(new FormData(event.target));
    const result = await api("/api/customers/import", { method: "POST", body: JSON.stringify(body) });
    $("#import-message").textContent = `导入完成：成功 ${result.imported} 条，失败 ${result.failed} 条。${result.errors?.length ? " " + result.errors.join("；") : ""}`;
    await loadState();
  } catch (error) {
    $("#import-message").textContent = error.message;
  }
});

$("#account-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("#account-message").textContent = "";
  try {
    const body = Object.fromEntries(new FormData(event.target));
    await api("/api/users", { method: "POST", body: JSON.stringify(body) });
    event.target.reset();
    $("#account-message").textContent = "子账号已创建。";
    await loadUsers();
  } catch (error) {
    $("#account-message").textContent = error.message;
  }
});

init().catch(error => {
  $("#login-error").textContent = error.message;
});
