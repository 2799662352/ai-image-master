# 余额管理：制作人项目-成员层级化展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 余额管理页面的 PRODUCER 级别，将成员展示从扁平列表改为嵌套在项目内的层级结构，通过 Semi Design Collapse 组件实现点击项目展开成员列表，支持从 ProducerProject 分配个人余额。

**Architecture:** 仅修改前端 `BalanceManagement/index.jsx`。后端 API 已全部就绪（`producer-project-members`, `allocate-project-to-personal`, `reclaim-project-from-personal`）。使用 Semi UI `Collapse` 组件将每个 ProducerProject 渲染为可展开面板，展开时懒加载该项目的成员列表。

**Tech Stack:** React, Semi UI (Collapse), Existing Go/Gin APIs

---

## 当前 vs 目标 UX

```
【当前 - 扁平】                        【目标 - 层级化】
┌─ zuozuoliang444 制作人 ¥0.00 ─┐      ┌─ zuozuoliang444 制作人 ¥0.00 ─┐
│                                │      │                                │
│ ▼ 下级组织                     │      │ ▼ 下级项目                     │
│ [项目 121212 ¥970] [划拨][扣款]│      │ ▸ 项目 121212  ¥970 [划拨][回收]│ ← 点击展开
│                                │      │   ├ MemberA ¥0  [分配][回收]   │
│ ▼ 成员余额                     │      │   └ MemberB ¥0  [分配][回收]   │
│ 8814c33b ¥0  [分配][流水]      │      │ ▸ 项目 XXX  ¥300  [划拨][回收] │ ← 折叠
│ 226ab507 ¥0  [分配][流水]      │      │                                │
└────────────────────────────────┘      └────────────────────────────────┘
```

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `new-api/web/src/pages/BalanceManagement/index.jsx` | 修改 | 唯一需修改的文件 |

**后端 API（已存在，无需修改）：**
- `GET /api/org/:producerId/producer-project-members?project_id=:ppId` → 返回成员列表含余额
- `POST /api/org/:producerId/allocate-project-to-personal` → ProducerProject→个人分配
- `POST /api/org/:producerId/reclaim-project-from-personal` → ProducerProject→个人回收

---

### Task 1: 添加 Collapse 导入和 PRODUCER 成员状态

**Files:**
- Modify: `new-api/web/src/pages/BalanceManagement/index.jsx:1-16` (imports)
- Modify: `new-api/web/src/pages/BalanceManagement/index.jsx:155-170` (state declarations)

- [ ] **Step 1: 添加 Collapse 到 Semi UI 导入**

在第 2-16 行的 import 中添加 `Collapse`：

```jsx
import {
  Modal,
  Form,
  Tag,
  Typography,
  Select,
  Empty,
  Spin,
  Space,
  Pagination,
  Table,
  Button,
  Avatar,
  Divider,
  Collapse,        // ← 新增
} from '@douyinfe/semi-ui';
```

- [ ] **Step 2: 添加 ProducerProject 成员相关 state**

在现有 state 声明区域（约 155-170 行），找到 `personalReclaimFormApi` 附近，添加：

```jsx
const [ppMembersMap, setPpMembersMap] = useState({});
const [ppMembersLoading, setPpMembersLoading] = useState({});
const [ppAllocModalVisible, setPpAllocModalVisible] = useState(false);
const [ppAllocTarget, setPpAllocTarget] = useState(null); // { ppId, ppName, member }
const ppAllocFormApi = useRef(null);
const [ppReclaimModalVisible, setPpReclaimModalVisible] = useState(false);
const [ppReclaimTarget, setPpReclaimTarget] = useState(null);
const ppReclaimFormApi = useRef(null);
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/BalanceManagement/index.jsx
git commit -m "feat(balance): add Collapse import and ProducerProject member state"
```

---

### Task 2: 添加 ProducerProject 成员加载和分配/回收函数

**Files:**
- Modify: `new-api/web/src/pages/BalanceManagement/index.jsx` (在 `handlePersonalReclaim` 函数之后，约 350 行)

- [ ] **Step 1: 添加 loadPpMembers 函数**

在 `handlePersonalReclaim` 函数之后（约 350 行），添加：

```jsx
const loadPpMembers = useCallback(async (ppId) => {
  if (!myOrg) return;
  setPpMembersLoading(prev => ({ ...prev, [ppId]: true }));
  try {
    const res = await API.get(`/api/org/${myOrg.id}/producer-project-members`, {
      params: { project_id: ppId },
    });
    if (res.data.success) {
      setPpMembersMap(prev => ({ ...prev, [ppId]: res.data.data || [] }));
    }
  } catch (e) { console.warn('加载项目成员失败', e.message); }
  finally {
    setPpMembersLoading(prev => ({ ...prev, [ppId]: false }));
  }
}, [myOrg]);

const handlePpAllocate = async (values) => {
  if (!myOrg || !ppAllocTarget) return;
  setSubmitting(true);
  try {
    const res = await API.post(`/api/org/${myOrg.id}/allocate-project-to-personal`, {
      producer_project_id: ppAllocTarget.ppId,
      platform_user_id: ppAllocTarget.member.platform_user_id,
      amount_yuan: values.amount_yuan,
    });
    if (res.data.success) {
      showSuccess(`已分配 ¥${values.amount_yuan} 给 ${ppAllocTarget.member.display_name || ppAllocTarget.member.platform_user_id}`);
      setPpAllocModalVisible(false);
      refreshMyOrg();
      loadPpMembers(ppAllocTarget.ppId);
    } else { showError(res.data.message || '分配失败'); }
  } catch (e) { showError(e.message); }
  finally { setSubmitting(false); }
};

const handlePpReclaim = async (values) => {
  if (!myOrg || !ppReclaimTarget) return;
  setSubmitting(true);
  try {
    const res = await API.post(`/api/org/${myOrg.id}/reclaim-project-from-personal`, {
      producer_project_id: ppReclaimTarget.ppId,
      platform_user_id: ppReclaimTarget.member.platform_user_id,
      amount_yuan: values.amount_yuan,
    });
    if (res.data.success) {
      showSuccess(`已回收 ¥${values.amount_yuan}`);
      setPpReclaimModalVisible(false);
      refreshMyOrg();
      loadPpMembers(ppReclaimTarget.ppId);
    } else { showError(res.data.message || '回收失败'); }
  } catch (e) { showError(e.message); }
  finally { setSubmitting(false); }
};
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/BalanceManagement/index.jsx
git commit -m "feat(balance): add ProducerProject member load/allocate/reclaim functions"
```

---

### Task 3: 替换 PRODUCER 的"下级组织 + 成员余额"为 Collapse 层级视图

**Files:**
- Modify: `new-api/web/src/pages/BalanceManagement/index.jsx` (约 599-755 行，子组织 + 成员余额渲染区域)

- [ ] **Step 1: 对 PRODUCER 级别替换渲染逻辑**

找到第 599 行 `{/* 下级组织列表 */}` 开始到第 755 行（成员余额区域的闭合 `)}` ）。

将整个区域改为条件分支：PRODUCER 用 Collapse，其他级别保持原样。

替换策略：在 `{/* 下级组织列表 */}` 处加入 PRODUCER 分支：

```jsx
{/* PRODUCER 级别：项目+成员层级化 Collapse 视图 */}
{myOrg.level === 'PRODUCER' && childOrgs.length > 0 && (
  <div className="modern-card" style={{ animationDelay: '0.1s' }}>
    <Typography.Title heading={5} style={{ marginBottom: 16 }}>{t('项目余额与成员')}</Typography.Title>
    <Collapse
      accordion={false}
      onChange={(keys) => {
        // 懒加载：展开时加载成员
        if (Array.isArray(keys)) {
          keys.forEach(k => {
            const ppId = Number(k);
            if (!ppMembersMap[ppId] && !ppMembersLoading[ppId]) {
              loadPpMembers(ppId);
            }
          });
        }
      }}
    >
      {childOrgs.map((pp) => (
        <Collapse.Panel
          key={String(pp.id)}
          itemKey={String(pp.id)}
          header={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingRight: 8 }}>
              <Space align="center">
                <Tag color="cyan" size="small">项目</Tag>
                <Typography.Text strong>{pp.name}</Typography.Text>
                {!pp.is_active && <Tag color="red" size="small">{t('已停用')}</Tag>}
              </Space>
              <Typography.Text strong style={{ fontSize: 18 }}>¥{toYuan(pp.balance)}</Typography.Text>
            </div>
          }
        >
          {/* 项目操作按钮 */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <Button size="small" theme="solid" type="primary" icon={<IconSend />}
              disabled={!pp.is_active}
              onClick={(e) => { e.stopPropagation(); openAllocateModal(pp); }}>
              {t('划拨')}
            </Button>
            <Button size="small" theme="light" type="warning" icon={<IconMinus />}
              onClick={(e) => { e.stopPropagation(); setReclaimTargetOrg(pp); setReclaimModalVisible(true); }}>
              {t('回收')}
            </Button>
            <Button size="small" theme="light" icon={<IconRefresh />}
              loading={ppMembersLoading[pp.id]}
              onClick={(e) => { e.stopPropagation(); loadPpMembers(pp.id); }}>
              {t('刷新成员')}
            </Button>
          </div>

          {/* 成员列表 */}
          <Spin spinning={!!ppMembersLoading[pp.id]}>
            {(ppMembersMap[pp.id] || []).length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {(ppMembersMap[pp.id] || []).map((member) => (
                  <div key={member.platform_user_id} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '10px 12px', borderRadius: 10,
                    background: 'var(--semi-color-bg-1)', border: '1px solid var(--semi-color-border)',
                  }}>
                    <div>
                      <Space align="center" style={{ marginBottom: 2 }}>
                        <Avatar size="extra-small" color="cyan">
                          {(member.display_name || '?').charAt(0)}
                        </Avatar>
                        <Typography.Text strong>
                          {member.display_name || member.platform_user_id.slice(0, 8)}
                        </Typography.Text>
                        {member.phone && <Typography.Text type="tertiary" size="small">{member.phone}</Typography.Text>}
                      </Space>
                      <div style={{ fontSize: 16, fontWeight: 700, color: member.has_allocation ? 'var(--semi-color-text-1)' : 'var(--semi-color-text-3)' }}>
                        {member.has_allocation ? `¥${Number(member.balance_yuan || 0).toFixed(2)}` : '未分配'}
                      </div>
                    </div>
                    <Space>
                      <Button size="small" theme="solid" type="primary" icon={<IconSend />}
                        disabled={(pp.balance || 0) <= 0}
                        onClick={() => {
                          setPpAllocTarget({ ppId: pp.id, ppName: pp.name, member });
                          setPpAllocModalVisible(true);
                          if (ppAllocFormApi.current) ppAllocFormApi.current.reset();
                        }}>
                        {t('分配余额')}
                      </Button>
                      {member.has_allocation && Number(member.balance_yuan || 0) > 0 && (
                        <Button size="small" theme="light" type="warning" icon={<IconMinus />}
                          onClick={() => {
                            setPpReclaimTarget({ ppId: pp.id, ppName: pp.name, member });
                            setPpReclaimModalVisible(true);
                            if (ppReclaimFormApi.current) ppReclaimFormApi.current.reset();
                          }}>
                          {t('回收')}
                        </Button>
                      )}
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description={t('暂无成员，请在组织管理中添加项目成员')} style={{ padding: '16px 0' }} />
            )}
          </Spin>
        </Collapse.Panel>
      ))}
    </Collapse>
  </div>
)}

{/* 非 PRODUCER 下级组织列表（保持原有逻辑） */}
{myOrg.level !== 'PRODUCER' && childOrgs.length > 0 && (
  // ... 原有的下级组织渲染代码不变 ...
)}
```

- [ ] **Step 2: 修改成员余额区域，PRODUCER 不再显示扁平成员列表**

找到第 673 行 `{/* 项目成员余额（项目/制作人级别显示） */}`，将条件改为只对 PROJECT 显示：

```jsx
{/* 项目成员余额（仅 PROJECT 级别显示，PRODUCER 已在 Collapse 中展示） */}
{myOrg.level === 'PROJECT' && (
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/BalanceManagement/index.jsx
git commit -m "feat(balance): replace flat member list with Collapse hierarchy for PRODUCER"
```

---

### Task 4: 添加 ProducerProject 成员分配/回收 Modal

**Files:**
- Modify: `new-api/web/src/pages/BalanceManagement/index.jsx` (在文件末尾的 Modal 区域，约 820-860 行)

- [ ] **Step 1: 在 Personal Reclaim Modal 之后添加两个新 Modal**

找到 `{/* Tx Modal */}` 注释之前，添加：

```jsx
{/* ProducerProject → Personal 分配 Modal */}
<Modal title={`${t('项目分配余额')} — ${ppAllocTarget?.ppName || ''} → ${ppAllocTarget?.member?.display_name || ''}`}
  visible={ppAllocModalVisible} onCancel={() => setPpAllocModalVisible(false)} footer={null} closeOnEsc>
  <Form onSubmit={handlePpAllocate} getFormApi={api => ppAllocFormApi.current = api}>
    <Form.InputNumber field='amount_yuan' label={t('分配金额 (元)')}
      rules={[{ required: true, message: t('请输入金额') }, { validator: (_, val) => val > 0, message: t('金额必须大于 0') }]}
      min={0.01} step={10} precision={2} prefix='¥' style={{ width: '100%' }} size="large" autoFocus />
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
      <Button onClick={() => setPpAllocModalVisible(false)}>{t('取消')}</Button>
      <Button htmlType='submit' theme='solid' type='primary' loading={submitting}>{t('确认分配')}</Button>
    </div>
  </Form>
</Modal>

{/* ProducerProject → Personal 回收 Modal */}
<Modal title={`${t('回收余额')} — ${ppReclaimTarget?.member?.display_name || ''}`}
  visible={ppReclaimModalVisible} onCancel={() => setPpReclaimModalVisible(false)} footer={null} closeOnEsc>
  {ppReclaimTarget && (
    <div className="bm-info-box bm-info-box--danger">
      <Typography.Text type="secondary">{t('该成员当前余额：')}</Typography.Text>
      <Typography.Text strong type="danger" style={{ fontSize: 16, marginLeft: 8 }}>
        ¥{Number(ppReclaimTarget?.member?.balance_yuan || 0).toFixed(2)}
      </Typography.Text>
    </div>
  )}
  <Form onSubmit={handlePpReclaim} getFormApi={api => ppReclaimFormApi.current = api}>
    <Form.InputNumber field='amount_yuan' label={t('回收金额 (元)')}
      rules={[{ required: true, message: t('请输入金额') }, { validator: (_, val) => val > 0, message: t('金额必须大于 0') }]}
      min={0.01} max={Number(ppReclaimTarget?.member?.balance_yuan || 0)} step={10} precision={2} prefix='¥' style={{ width: '100%' }} size="large" autoFocus />
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
      <Button onClick={() => setPpReclaimModalVisible(false)}>{t('取消')}</Button>
      <Button htmlType='submit' theme='solid' type='danger' loading={submitting}>{t('确认回收')}</Button>
    </div>
  </Form>
</Modal>
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/BalanceManagement/index.jsx
git commit -m "feat(balance): add ProducerProject member allocate/reclaim modals"
```

---

### Task 5: 构建部署验证

- [ ] **Step 1: Docker 构建**

```bash
cd d:\tecx\text && docker compose -f docker-compose.local.yml build sora-new-api
```

- [ ] **Step 2: 重启容器**

```bash
docker compose -f docker-compose.local.yml up -d sora-new-api
```

- [ ] **Step 3: 端到端验证**

1. 管理面板 → 余额管理 → 制作人页面
2. 确认显示"项目余额与成员"区域，每个 ProducerProject 为可展开面板
3. 点击展开 ProducerProject → 成员列表懒加载显示
4. 点击 "划拨" → 从制作人池分配给项目
5. 点击成员 "分配余额" → 从项目分配给个人
6. 确认余额数字实时更新
7. 前端 sora-ui → 用户余额显示正确
