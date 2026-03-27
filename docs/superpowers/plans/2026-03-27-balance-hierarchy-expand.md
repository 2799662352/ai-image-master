# Balance Hierarchy Expand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-root admin child cards expandable to show the full descendant tree, not just direct children.

**Architecture:** Reuse the existing `loadChildren` + `expandedChildren` state from root table view. Add a recursive `renderChildCard` component that renders a child with expand/collapse capability. Each expanded child lazy-loads its own children via `/api/org/{id}/children?stats=1` or `/api/org/{id}/producer-projects?stats=1`.

**Tech Stack:** React, Semi Design (Collapse, Spin, Button), existing Go backend APIs (no backend changes needed — `GetChildren?stats=1` and `GetProducerProjects?stats=1` already return formula-based stats).

---

### Task 1: Add recursive child card rendering with expand/collapse

**Files:**
- Modify: `25/soraui_4.0/new-api/web/src/pages/BalanceManagement/index.jsx` (lines 985-1055, child card section)

**Current State:** Non-PRODUCER child cards render a flat list: `{childOrgs.map((child) => <card>)}`. No expand. The root table already has `loadChildren(orgId, level)` and `expandedChildren[orgId]` state — we reuse these.

**Plan:**
- [x] **Step 1: Extract a `renderChildCardList` function** that takes an array of children and a depth, renders each child card, and for non-leaf orgs (COMPANY, STUDIO, PRODUCER) shows an expand toggle.
- [x] **Step 2: On expand, call `loadChildren(child.id, child.level)`** which fetches children (or producer-projects) with stats=1 and stores in `expandedChildren[child.id]`.
- [x] **Step 3: When `expandedChildren[child.id]` exists, render nested child cards** with left indent (`marginLeft: depth * 24px`).
- [x] **Step 4: For PRODUCER children, render nested producer-project cards** (same pattern — `loadChildren` with level='PRODUCER' fetches producer-projects).
- [x] **Step 5: Build and verify** Docker build succeeded, container restarted, HTTP 200 confirmed.
