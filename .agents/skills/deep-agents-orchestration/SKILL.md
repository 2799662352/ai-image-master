---
name: deep-agents-orchestration
description: "INVOKE THIS SKILL when using subagents, task planning, or human approval in Deep Agents. Covers SubAgentMiddleware, TodoList for planning, and HITL interrupts."
---

<overview>
Deep Agents include three orchestration capabilities:

1. **SubAgentMiddleware**: Delegate work via `task` tool to specialized agents
2. **TodoListMiddleware**: Plan and track tasks via `write_todos` tool
3. **HumanInTheLoopMiddleware**: Require approval before sensitive operations

All three are automatically included in `create_deep_agent()`.
</overview>

---

## Subagents (Task Delegation)

<when-to-use-subagents>

| Use Subagents When | Use Main Agent When |
|-------------------|-------------------|
| Task needs specialized tools | General-purpose tools sufficient |
| Want to isolate complex work | Single-step operation |
| Need clean context for main agent | Context bloat acceptable |

</when-to-use-subagents>

<how-subagents-work>
Main agent has `task` tool -> creates fresh subagent -> subagent executes autonomously -> returns final report.

**Default subagent**: "general-purpose" - automatically available with same tools/config as main agent.
</how-subagents-work>

<subagent-config-fields>
SubAgent dictionary fields:

**Required:** `name`, `description`, `system_prompt`, `tools`
**Optional:** `model` (`"provider:model"` format), `middleware`, `interrupt_on`, `skills`

- `skills`: List of skill source paths. Does NOT inherit from main agent. Only the general-purpose subagent inherits main agent's skills.
- `middleware`: Additional middleware list. Does not inherit from main agent.
- `model`: Inherits from main agent by default. Override with string like `"openai:gpt-4o"` or a ChatModel instance.
- `interrupt_on`: Inherits from main agent by default. Subagent value overrides.
</subagent-config-fields>

<ex-custom-subagents>
<python>
Create a custom "researcher" subagent with specialized tools for academic paper search.
```python
from deepagents import create_deep_agent
from langchain.tools import tool

@tool
def search_papers(query: str) -> str:
    """Search academic papers."""
    return f"Found 10 papers about {query}"

agent = create_deep_agent(
    subagents=[
        {
            "name": "researcher",
            "description": "Conduct web research and compile findings",
            "system_prompt": "Search thoroughly, return concise summary",
            "tools": [search_papers],
        }
    ]
)

# Main agent delegates: task(agent="researcher", instruction="Research AI trends")
```
</python>
<typescript>
Create a custom "researcher" subagent with specialized tools for academic paper search.
```typescript
import { createDeepAgent } from "deepagents";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const searchPapers = tool(
  async ({ query }) => `Found 10 papers about ${query}`,
  { name: "search_papers", description: "Search papers", schema: z.object({ query: z.string() }) }
);

const agent = await createDeepAgent({
  subagents: [
    {
      name: "researcher",
      description: "Conduct web research and compile findings",
      systemPrompt: "Search thoroughly, return concise summary",
      tools: [searchPapers],
    }
  ]
});

// Main agent delegates: task(agent="researcher", instruction="Research AI trends")
```
</typescript>
</ex-custom-subagents>

<ex-subagent-with-hitl>
<python>
Configure a subagent with HITL approval for sensitive operations.
```python
from deepagents import create_deep_agent
from langgraph.checkpoint.memory import MemorySaver

agent = create_deep_agent(
    subagents=[
        {
            "name": "code-deployer",
            "description": "Deploy code to production",
            "system_prompt": "You deploy code after tests pass.",
            "tools": [run_tests, deploy_to_prod],
            "interrupt_on": {"deploy_to_prod": True},  # Require approval
        }
    ],
    checkpointer=MemorySaver()  # Required for interrupts
)
```
</python>
</ex-subagent-with-hitl>

<ex-compiled-subagent>
<python>
Use a pre-built LangGraph graph as a subagent via CompiledSubAgent.
```python
from deepagents import create_deep_agent, CompiledSubAgent
from langchain.agents import create_agent

custom_graph = create_agent(
    model="gpt-4o",
    tools=specialized_tools,
    prompt="You are a data analysis specialist."
)

agent = create_deep_agent(
    subagents=[
        CompiledSubAgent(
            name="data-analyzer",
            description="Specialized agent for complex data analysis",
            runnable=custom_graph,
        )
    ]
)
```
</python>
</ex-compiled-subagent>

<ex-override-general-purpose>
<python>
Override the default general-purpose subagent by providing a subagent with name="general-purpose".
```python
agent = create_deep_agent(
    model="claude-sonnet-4-6",
    subagents=[
        {
            "name": "general-purpose",
            "description": "General-purpose agent for research and multi-step tasks",
            "system_prompt": "You are a general-purpose assistant.",
            "tools": [internet_search],
            "model": "openai:gpt-4o",
        },
    ],
)
```
</python>
</ex-override-general-purpose>

<fix-subagents-are-stateless>
<python>
Subagents are stateless - provide complete instructions in a single call.
```python
# WRONG: Subagents don't remember previous calls
# task(agent='research', instruction='Find data')
# task(agent='research', instruction='What did you find?')  # Starts fresh!

# CORRECT: Complete instructions upfront
# task(agent='research', instruction='Find data on AI, save to /research/, return summary')
```
</python>
<typescript>
Subagents are stateless - provide complete instructions in a single call.
```typescript
// WRONG: Subagents don't remember previous calls
// task research: Find data
// task research: What did you find?  // Starts fresh!

// CORRECT: Complete instructions upfront
// task research: Find data on AI, save to /research/, return summary
```
</typescript>
</fix-subagents-are-stateless>

<fix-custom-subagents-dont-inherit-skills>
<python>
Custom subagents don't inherit skills from the main agent.
```python
# WRONG: Custom subagent won't have main agent's skills
agent = create_deep_agent(
    skills=["/main-skills/"],
    subagents=[{"name": "helper", ...}]  # No skills inherited
)

# CORRECT: Provide skills explicitly (general-purpose subagent DOES inherit)
agent = create_deep_agent(
    skills=["/main-skills/"],
    subagents=[{"name": "helper", "skills": ["/helper-skills/"], ...}]
)
```
</python>
</fix-custom-subagents-dont-inherit-skills>

---

## TodoList (Task Planning)

<when-to-use-todolist>

| Use TodoList When | Skip TodoList When |
|------------------|-------------------|
| Complex multi-step tasks | Simple single-action tasks |
| Long-running operations | Quick operations (< 3 steps) |

</when-to-use-todolist>

<todolist-tool>
```
write_todos(todos: list[dict]) -> None
```

Each todo item has:
- `content`: Description of the task
- `status`: One of `"pending"`, `"in_progress"`, `"completed"`
</todolist-tool>

<ex-todolist-usage>
<python>
Invoke an agent that automatically creates a todo list for a multi-step task.
```python
from deepagents import create_deep_agent

agent = create_deep_agent()  # TodoListMiddleware included by default

result = agent.invoke({
    "messages": [{"role": "user", "content": "Create a REST API: design models, implement CRUD, add auth, write tests"}]
}, config={"configurable": {"thread_id": "session-1"}})

# Agent's planning via write_todos:
# [
#   {"content": "Design data models", "status": "in_progress"},
#   {"content": "Implement CRUD endpoints", "status": "pending"},
#   {"content": "Add authentication", "status": "pending"},
#   {"content": "Write tests", "status": "pending"}
# ]
```
</python>
<typescript>
Invoke an agent that automatically creates a todo list for a multi-step task.
```typescript
import { createDeepAgent } from "deepagents";

const agent = await createDeepAgent();  // TodoListMiddleware included

const result = await agent.invoke({
  messages: [{ role: "user", content: "Create a REST API: design models, implement CRUD, add auth, write tests" }]
}, { configurable: { thread_id: "session-1" } });
```
</typescript>
</ex-todolist-usage>

<ex-access-todo-state>
<python>
Access the todo list from the agent's final state after invocation.
```python
result = agent.invoke({...}, config={"configurable": {"thread_id": "session-1"}})

# Access todo list from final state
todos = result.get("todos", [])
for todo in todos:
    print(f"[{todo['status']}] {todo['content']}")
```
</python>
</ex-access-todo-state>

<fix-todolist-requires-thread-id>
<python>
Todo list state requires a thread_id for persistence across invocations.
```python
# WRONG: Fresh state each time without thread_id
agent.invoke({"messages": [...]})

# CORRECT: Use thread_id
config = {"configurable": {"thread_id": "user-session"}}
agent.invoke({"messages": [...]}, config=config)  # Todos preserved
```
</python>
</fix-todolist-requires-thread-id>

---

## Human-in-the-Loop (Approval Workflows)

<when-to-use-hitl>

| Use HITL When | Skip HITL When |
|--------------|---------------|
| High-stakes operations (DB writes, deployments) | Read-only operations |
| Compliance requires human oversight | Fully automated workflows |

</when-to-use-hitl>

<ex-hitl-setup>
<python>
Configure which tools require human approval before execution.
```python
from deepagents import create_deep_agent
from langgraph.checkpoint.memory import MemorySaver

agent = create_deep_agent(
    interrupt_on={
        "write_file": True,  # All decisions allowed
        "execute_sql": {"allowed_decisions": ["approve", "reject"]},
        "read_file": False,  # No interrupts
    },
    checkpointer=MemorySaver()  # REQUIRED for interrupts
)
```
</python>
<typescript>
Configure which tools require human approval before execution.
```typescript
import { createDeepAgent } from "deepagents";
import { MemorySaver } from "@langchain/langgraph";

const agent = await createDeepAgent({
  interruptOn: {
    write_file: true,
    execute_sql: { allowedDecisions: ["approve", "reject"] },
    read_file: false,
  },
  checkpointer: new MemorySaver()  // REQUIRED
});
```
</typescript>
</ex-hitl-setup>

<ex-approval-workflow>
<python>
Complete workflow: trigger an interrupt, check state, approve action, and resume execution.
```python
from deepagents import create_deep_agent
from langgraph.checkpoint.memory import MemorySaver
from langgraph.types import Command

agent = create_deep_agent(
    interrupt_on={"write_file": True},
    checkpointer=MemorySaver()
)

config = {"configurable": {"thread_id": "session-1"}}

# Step 1: Agent proposes write_file - execution pauses
result = agent.invoke({
    "messages": [{"role": "user", "content": "Write config to /prod.yaml"}]
}, config=config)

# Step 2: Check for interrupts
if result.get("__interrupt__"):
    interrupts = result["__interrupt__"][0].value
    action_requests = interrupts["action_requests"]
    for action in action_requests:
        print(f"Tool: {action['name']}, Args: {action['args']}")

    # Step 3: Approve and resume
    decisions = [{"type": "approve"}]
    result = agent.invoke(
        Command(resume={"decisions": decisions}),
        config=config
    )
```
</python>
<typescript>
Complete workflow: trigger an interrupt, check state, approve action, and resume execution.
```typescript
import { createDeepAgent } from "deepagents";
import { MemorySaver, Command } from "@langchain/langgraph";

const agent = await createDeepAgent({
  interruptOn: { write_file: true },
  checkpointer: new MemorySaver()
});

const config = { configurable: { thread_id: "session-1" } };

// Step 1: Agent proposes write_file - execution pauses
let result = await agent.invoke({
  messages: [{ role: "user", content: "Write config to /prod.yaml" }]
}, config);

// Step 2: Check for interrupts
if (result["__interrupt__"]) {
  const interrupts = result["__interrupt__"][0].value;
  const actionRequests = interrupts.action_requests;
  for (const action of actionRequests) {
    console.log(`Tool: ${action.name}, Args: ${JSON.stringify(action.args)}`);
  }

  // Step 3: Approve and resume
  const decisions = [{ type: "approve" }];
  result = await agent.invoke(
    new Command({ resume: { decisions } }), config
  );
}
```
</typescript>
</ex-approval-workflow>

<ex-reject-with-feedback>
<python>
Reject a pending action with feedback, prompting the agent to try a different approach.
```python
result = agent.invoke(
    Command(resume={"decisions": [{"type": "reject", "message": "Run tests first"}]}),
    config=config,
)
```
</python>
<typescript>
Reject a pending action with feedback, prompting the agent to try a different approach.
```typescript
const result = await agent.invoke(
  new Command({ resume: { decisions: [{ type: "reject", message: "Run tests first" }] } }),
  config,
);
```
</typescript>
</ex-reject-with-feedback>

<ex-edit-before-execution>
<python>
Edit the proposed action arguments before allowing execution.
```python
result = agent.invoke(
    Command(resume={"decisions": [{
        "type": "edit",
        "edited_action": {
            "name": "execute_sql",
            "args": {"query": "DELETE FROM users WHERE last_login < '2020-01-01' LIMIT 100"},
        },
    }]}),
    config=config,
)
```
</python>
</ex-edit-before-execution>

<ex-batch-interrupts>
<python>
When multiple tools require approval, all are batched in a single interrupt. Provide decisions in order.
```python
result = agent.invoke({
    "messages": [{"role": "user", "content": "Delete temp.txt and send email to admin"}]
}, config=config)

if result.get("__interrupt__"):
    interrupts = result["__interrupt__"][0].value
    action_requests = interrupts["action_requests"]
    # Provide one decision per action, in same order
    decisions = [
        {"type": "approve"},  # First tool: delete_file
        {"type": "reject"},   # Second tool: send_email
    ]
    result = agent.invoke(Command(resume={"decisions": decisions}), config=config)
```
</python>
</ex-batch-interrupts>

<boundaries>
### What Agents CAN Configure

- Subagent names, tools, models, system prompts
- Which tools require approval
- Allowed decision types per tool
- TodoList content and structure

### What Agents CANNOT Configure

- Tool names (`task`, `write_todos`)
- HITL protocol (approve/edit/reject structure)
- Skip checkpointer requirement for interrupts
- Make subagents stateful (they're ephemeral)
</boundaries>

<fix-checkpointer-required>
<python>
Checkpointer is required when using interrupt_on for HITL workflows.
```python
# WRONG
agent = create_deep_agent(interrupt_on={"write_file": True})

# CORRECT
agent = create_deep_agent(interrupt_on={"write_file": True}, checkpointer=MemorySaver())
```
</python>
<typescript>
Checkpointer is required when using interruptOn for HITL workflows.
```typescript
// WRONG
const agent = await createDeepAgent({ interruptOn: { write_file: true } });

// CORRECT
const agent = await createDeepAgent({ interruptOn: { write_file: true }, checkpointer: new MemorySaver() });
```
</typescript>
</fix-checkpointer-required>

<fix-thread-id-required-for-resumption>
<python>
A consistent thread_id is required to resume interrupted workflows.
```python
# WRONG: Can't resume without thread_id
agent.invoke({"messages": [...]})

# CORRECT
config = {"configurable": {"thread_id": "session-1"}}
agent.invoke({...}, config=config)
# Resume with Command using same config
agent.invoke(Command(resume={"decisions": [{"type": "approve"}]}), config=config)
```
</python>
<typescript>
A consistent thread_id is required to resume interrupted workflows.
```typescript
// WRONG: Can't resume without thread_id
await agent.invoke({ messages: [...] });

// CORRECT
const config = { configurable: { thread_id: "session-1" } };
await agent.invoke({ messages: [...] }, config);
// Resume with Command using same config
await agent.invoke(new Command({ resume: { decisions: [{ type: "approve" }] } }), config);
```
</typescript>
</fix-thread-id-required-for-resumption>

<fix-interrupt-checks-between-invocations>
<python>
Interrupts happen BETWEEN invoke() calls, not mid-execution.
```python
result = agent.invoke({...}, config=config)
if result.get("__interrupt__"):
    result = agent.invoke(
        Command(resume={"decisions": [{"type": "approve"}]}),
        config=config,
    )
```
</python>
</fix-interrupt-checks-between-invocations>
