CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  account TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT NOT NULL,
  region TEXT NOT NULL,
  owner TEXT NOT NULL,
  stage TEXT NOT NULL,
  budget INTEGER NOT NULL DEFAULT 0,
  contact TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  next_follow_up TEXT NOT NULL,
  last_follow_up TEXT NOT NULL,
  score_value INTEGER NOT NULL DEFAULT 50,
  score_intent INTEGER NOT NULL DEFAULT 50,
  score_activity INTEGER NOT NULL DEFAULT 50,
  score_relationship INTEGER NOT NULL DEFAULT 50,
  score_payment INTEGER NOT NULL DEFAULT 50,
  score_risk_control INTEGER NOT NULL DEFAULT 50,
  created_by TEXT DEFAULT 'u1',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  followup_date TEXT NOT NULL,
  method TEXT NOT NULL,
  result TEXT NOT NULL,
  content TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX IF NOT EXISTS idx_customers_owner ON customers(owner);
CREATE INDEX IF NOT EXISTS idx_customers_created_by ON customers(created_by);
CREATE INDEX IF NOT EXISTS idx_customers_stage ON customers(stage);
CREATE INDEX IF NOT EXISTS idx_customers_next_follow_up ON customers(next_follow_up);
CREATE INDEX IF NOT EXISTS idx_followups_customer_id ON followups(customer_id);

INSERT OR IGNORE INTO users (id, name, account, password_hash, role) VALUES
('u1', '管理员', 'admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', '管理员'),
('u2', '林晨', 'linchen', '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92', '销售'),
('u3', '许诺', 'xunuo', '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92', '销售主管');

INSERT OR IGNORE INTO customers (
  id, name, industry, region, owner, stage, budget, contact, phone, source, tags,
  next_follow_up, last_follow_up, score_value, score_intent, score_activity,
  score_relationship, score_payment, score_risk_control
) VALUES
('c1', '杭州云帆智造有限公司', '智能制造', '浙江杭州', '林晨', '报价中', 280, '周总 / 采购负责人', '138-0000-1024', '展会线索', '["高预算","老板关注","本月决策"]', '2026-07-15', '2026-07-12', 92, 86, 78, 82, 74, 68),
('c2', '上海瑞禾连锁商业集团', '连锁零售', '上海', '许诺', '需求确认', 190, '李经理 / 数字化负责人', '136-0000-8848', '老客户转介绍', '["多门店","流程复杂","需方案"]', '2026-07-14', '2026-07-10', 82, 76, 88, 70, 80, 73),
('c3', '苏州科启医疗器械', '医疗器械', '江苏苏州', '林晨', '已联系', 85, '王主任 / 运营', '139-0000-2211', '官网咨询', '["价格敏感","需教育","竞品对比"]', '2026-07-16', '2026-07-06', 58, 62, 55, 48, 66, 52),
('c4', '广州越海供应链', '物流供应链', '广东广州', '赵言', '暂缓', 130, '陈总 / 总经理', '137-0000-9090', '渠道推荐', '["项目暂停","竞品介入","需高层维护"]', '2026-07-13', '2026-06-21', 76, 44, 30, 64, 58, 28);

INSERT OR IGNORE INTO followups (id, customer_id, followup_date, method, result, content, owner) VALUES
('f1', 'c1', '2026-07-12', '会议', '报价中', '客户确认 3 个部门参与试点，要求补充实施排期和售后响应承诺。', '林晨'),
('f2', 'c2', '2026-07-10', '电话', '需求确认', '客户希望先看门店经营数据看板案例，下周安排方案演示。', '许诺');
