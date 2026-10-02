DEALORA

Engineering & Product Roadmap

Project: DEALORA
Repository: "blockora/Dealora"
Primary Branch: "main"
Architecture Source of Truth: "DEALORA_BLUEPRINT.md"
Roadmap Status: Active
Roadmap Version: 1.0

---

1. PURPOSE

This roadmap defines how DEALORA must be built from the current repository state into a working AI Revenue Operating System.

This document is intended to be readable and executable by:

- AI coding agents
- software engineers
- product engineers
- technical founders
- reviewers

The roadmap must be followed together with:

"DEALORA_BLUEPRINT.md"

The blueprint defines what DEALORA is.

This roadmap defines how DEALORA is implemented.

---

2. NON-NEGOTIABLE RULE

Do not build features simply because they are technically interesting.

Every implementation must be evaluated against:

1. Customer value
2. Revenue impact
3. Technical simplicity
4. Security
5. Reliability
6. Explainability
7. Measurement
8. Long-term architecture
9. Unit economics
10. Evidence quality

When there is a conflict between a new feature and the core revenue workflow, prioritize the core revenue workflow.

---

3. CURRENT REPOSITORY STATE

The repository currently contains:

Dealora/
├── DEALORA_BLUEPRINT.md
├── LICENSE
└── README.md

The repository is currently a product foundation repository.

The application architecture has not yet been fully implemented.

The next work should therefore focus on establishing a clean engineering foundation before building advanced autonomous capabilities.

---

4. CORE PRODUCT LOOP

Every implementation decision must support this loop:

BUSINESS
   ↓
REVENUE GOAL
   ↓
ICP
   ↓
TARGET ACCOUNTS
   ↓
RESEARCH
   ↓
EVIDENCE
   ↓
QUALIFICATION
   ↓
PRIORITIZATION
   ↓
PERSONALIZATION
   ↓
HUMAN APPROVAL
   ↓
APPROVED ACTION
   ↓
RESPONSE
   ↓
MEETING
   ↓
OPPORTUNITY
   ↓
REVENUE
   ↓
LEARNING
   ↓
OPTIMIZATION

The MVP is not complete until this loop is demonstrably functional.

---

5. DEVELOPMENT PRINCIPLE

Build one complete revenue loop before building a huge platform.

Do NOT begin by building:

- marketplace
- dozens of integrations
- full CRM
- complex autonomous outreach
- enterprise SSO
- mobile application
- 50+ agents
- large scraping infrastructure
- advanced agent marketplace
- multi-channel mass outreach

First prove that DEALORA can reliably create a qualified revenue opportunity.

---

6. TARGET MVP

The first commercial version should target:

B2B service businesses

Examples:

- AI automation agencies
- software agencies
- web agencies
- marketing agencies
- consulting firms
- specialized B2B service providers

The initial product should help these businesses:

1. define a revenue goal
2. define an ICP
3. discover/import target accounts
4. research accounts
5. collect evidence
6. qualify prospects
7. generate evidence-backed personalization
8. request human approval
9. execute one approved action
10. classify replies
11. recommend meetings
12. measure pipeline and cost

---

7. PHASE 0 — REPOSITORY & ENGINEERING FOUNDATION

Objective

Turn the current minimal repository into a professional software foundation.

Deliverables

Create:

/
├── apps/
├── packages/
├── agents/
├── integrations/
├── workflows/
├── skills/
├── examples/
├── tests/
├── docs/
├── scripts/
├── cli/
├── README.md
├── SECURITY.md
├── CONTRIBUTING.md
├── LICENSE
├── DEALORA_BLUEPRINT.md
└── ROADMAP.md

Requirements

Establish:

- package manager
- monorepo structure
- TypeScript configuration
- linting
- formatting
- test framework
- build system
- environment configuration
- development scripts
- CI baseline
- documentation structure

GitHub Requirements

Create:

.github/
├── workflows/
├── ISSUE_TEMPLATE/
└── PULL_REQUEST_TEMPLATE.md

At minimum implement CI for:

- install
- lint
- typecheck
- tests
- build

Gate

Do not begin core product development until:

- repository builds
- tests execute
- linting works
- typechecking works
- CI passes

---

8. PHASE 1 — APPLICATION FOUNDATION

Objective

Create the minimum infrastructure required for a real multi-tenant SaaS product.

Core capabilities

Implement:

- authentication
- user identity
- workspace
- organization/business profile
- database
- API layer
- application configuration
- secure secrets handling
- basic authorization

Initial entities

Create foundational data models for:

User
Workspace
Organization
BusinessProfile
RevenueGoal
ICP
Persona
Account
Contact
Signal
Evidence
Campaign
Workflow
Agent
AgentVersion
Tool
Execution
Approval
Conversation
Message
Meeting
Opportunity
Customer
Revenue
Metric
Integration
AuditEvent

Not every entity needs full functionality in Phase 1.

Create the schema in a way that can evolve without destructive redesign.

Gate

A user must be able to:

Sign up
  ↓
Create workspace
  ↓
Create business profile
  ↓
Persist data
  ↓
Reload application
  ↓
See persisted workspace

---

9. PHASE 2 — BUSINESS BRAIN

Objective

Give DEALORA reliable business context.

Implement

Business Brain should support:

- company description
- products
- services
- pricing
- offers
- ICP
- buyer personas
- differentiators
- positioning
- case studies
- testimonials
- FAQs
- objections
- competitors
- brand voice
- policies
- approved claims
- sales playbooks

Critical rule

Agents must use the Business Brain as a canonical context source.

Agents must not invent:

- pricing
- case studies
- customer results
- capabilities
- guarantees
- product features

Gate

A user must be able to create and edit Business Brain data and an agent must be able to retrieve it as structured context.

---

10. PHASE 3 — REVENUE GOAL ENGINE

Objective

Allow the user to define the desired revenue outcome in natural language and structured form.

Example

User input:

I want 20 qualified meetings in the next 30 days
from US SaaS companies with 10-200 employees,
targeting founders and revenue leaders,
for an AI support automation offer,
with an expected contract value above $2,000.

Convert into:

RevenueGoal
├── objective
├── target
├── time_window
├── market
├── ICP
├── buyer
├── offer
├── economics
├── constraints
├── approval_policy
└── success_metrics

Requirements

Implement:

- goal creation
- goal editing
- goal validation
- structured goal representation
- goal status
- success metrics
- goal history

Gate

A user can create a measurable revenue goal and view its structured representation.

---

11. PHASE 4 — REVENUE PLAN COMPILER

Objective

Convert the goal into a proposed execution strategy.

Input

"RevenueGoal"

Output

"RevenuePlan"

Structure:

RevenuePlan
├── ICP
├── buyer personas
├── sourcing strategy
├── signal strategy
├── qualification policy
├── outreach strategy
├── follow-up policy
├── meeting strategy
├── CRM policy
├── measurement plan
└── optimization plan

Requirements

The compiler must:

- identify missing information
- produce explicit assumptions
- separate facts from recommendations
- produce measurable KPIs
- explain why a plan was proposed

Important

The compiler produces a proposal.

It must not automatically execute consequential external actions.

Gate

A revenue goal can be compiled into an inspectable revenue plan.

---

12. PHASE 5 — ACCOUNT & PROSPECT INPUT

Objective

Provide a reliable source of target accounts.

Initial methods:

- CSV import
- manual account creation
- manual contact creation
- one permitted external source

Do not build a large scraping system at this stage.

Data model

Account should support:

Account
├── name
├── domain
├── industry
├── employee_count
├── geography
├── source
├── metadata
└── status

Contact should support:

Contact
├── name
├── title
├── email
├── account_id
├── source
├── status
└── metadata

Gate

A user can import or create target accounts and contacts.

---

13. PHASE 6 — RESEARCH ENGINE

Objective

Generate structured, evidence-backed account research.

Research output

Each research result must support:

Claim
Source
Retrieved At
Confidence
Freshness
Relevance
Reference

Research categories

Initial research may include:

- company overview
- industry
- business model
- product/service information
- recent announcements
- hiring
- expansion
- leadership changes
- relevant technology signals
- public business changes

Critical rule

Never treat inference as fact.

Use explicit labels:

FACT
INFERENCE
HYPOTHESIS
RECOMMENDATION

Gate

A target account can receive an account brief where important claims are traceable to evidence.

---

14. PHASE 7 — EVIDENCE SYSTEM

Objective

Make evidence a first-class system rather than text hidden inside prompts.

Implement

Evidence entity:

Evidence
├── id
├── source
├── source_type
├── source_url
├── claim
├── claim_type
├── confidence
├── freshness
├── retrieved_at
├── relevance
└── related_entity

Requirements

Support:

- evidence storage
- evidence retrieval
- evidence linking
- confidence
- freshness
- source attribution
- audit trail

Gate

Generated claims can be traced back to evidence.

---

15. PHASE 8 — QUALIFICATION ENGINE

Objective

Determine whether an account fits the user's target.

Initial scoring dimensions

ICP Fit
Need Fit
Buying Signal
Timing
Company Fit

Example:

ICP Fit          95
Need Fit         89
Buying Signal    91
Timing            78
Company Fit       94
--------------------
Dealora Score     90

Requirements

Every score must have:

- score
- reason
- evidence
- confidence

The score is a decision aid.

It is not certainty.

Gate

A user can inspect why an account received a score.

---

16. PHASE 9 — PERSONALIZATION ENGINE

Objective

Generate useful, concise, evidence-backed outreach drafts.

Requirements

Personalization should prioritize:

- specificity
- relevance
- recency
- evidence
- usefulness
- brevity

Example

Weak:

I saw your company is growing rapidly.

Better:

Your company announced expansion into Germany in September.

Critical rule

Never fabricate personalization.

Every factual statement should be traceable to:

- Business Brain
- Evidence
- verified account data

Gate

The system can generate a personalized draft with supporting evidence.

---

17. PHASE 10 — APPROVAL ENGINE

Objective

Create human control before consequential actions.

Risk levels

Level 0 — Read

Examples:

- research
- analysis
- scoring
- summarization

Level 1 — Draft

Examples:

- message draft
- follow-up draft
- CRM note

Level 2 — External action

Examples:

- send message
- update CRM
- schedule event

Level 3 — High-impact action

Examples:

- financial commitment
- contract action
- irreversible change
- sensitive data operation

Requirements

Implement:

- approval request
- approval status
- approver
- timestamp
- action preview
- rejection
- expiration
- audit trail

Gate

No Level 2 or Level 3 production action may execute without an appropriate policy or explicit approval.

---

18. PHASE 11 — FIRST OUTBOUND INTEGRATION

Objective

Enable one real, controlled external communication workflow.

Choose exactly one initial channel.

The integration must support:

Draft
↓
Approval
↓
Send
↓
Delivery state
↓
Response

Requirements

Implement:

- OAuth/credential handling
- permission scopes
- rate limits
- send controls
- opt-out protection
- audit logging
- failure states
- retry policies

Critical rule

Do not build mass outreach infrastructure.

The first integration exists to prove the revenue loop.

Gate

A real approved message can be sent and its state can be observed.

---

19. PHASE 12 — CONVERSATION ENGINE

Objective

Interpret inbound responses.

Initial classification:

Interested
Question
Pricing
Objection
Not Now
Wrong Person
Unsubscribe
Positive Intent
Negative Intent
Unknown

Output

intent
confidence
recommended_next_action
human_intervention_required

Safety requirements

If the message indicates:

- unsubscribe
- negative intent
- sensitive issue
- uncertainty
- unusual request

the system should stop or escalate according to policy.

Gate

An inbound response can be classified and converted into a next action.

---

20. PHASE 13 — MEETING WORKFLOW

Objective

Convert positive intent into a meeting workflow.

Flow:

Positive Intent
      ↓
Qualification
      ↓
Meeting Recommendation
      ↓
Approval / Policy
      ↓
Calendar Action
      ↓
CRM Update
      ↓
Meeting Brief

Requirements

Implement:

- scheduling integration
- meeting recommendation
- booking state
- meeting metadata
- meeting preparation

Gate

A qualified positive response can result in a measurable meeting state.

---

21. PHASE 14 — NEXT-BEST-ACTION ENGINE

Objective

Answer:

What should happen next?

Example:

Account:
Acme

Current State:
Positive reply received

Recommended Action:
Offer meeting

Reason:
High intent + strong ICP fit + explicit request

Confidence:
93%

Requirements

Every recommendation should include:

- action
- reason
- supporting state
- evidence
- confidence
- expected outcome
- approval requirement

Gate

Users can see the next recommended action for meaningful revenue states.

---

22. PHASE 15 — REVENUE GRAPH

Objective

Create relationships between revenue entities.

Core relationships:

Company
Person
Signal
Evidence
Campaign
Conversation
Meeting
Opportunity
Customer
Revenue
Agent
Workflow

Example:

Company
  ↓
Signal
  ↓
Prospect
  ↓
Campaign
  ↓
Conversation
  ↓
Meeting
  ↓
Opportunity
  ↓
Customer
  ↓
Revenue

Gate

The system can trace the lifecycle of an opportunity.

---

23. PHASE 16 — COST ENGINE

Objective

Understand the true economic cost of automation.

Track:

- LLM cost
- search cost
- data cost
- tool cost
- infrastructure cost
- execution cost

Derived metrics:

Cost / Prospect
Cost / Qualified Opportunity
Cost / Meeting
Cost / Customer
Revenue / AI Cost
Revenue / Campaign

Gate

A workflow execution can show estimated or measured cost.

---

24. PHASE 17 — REVENUE DASHBOARD

Objective

Make business outcomes visible.

Initial dashboard:

Revenue Goal
Direct Revenue
Pipeline Created
Qualified Prospects
Positive Conversations
Meetings
Opportunities
Customers
Agent Activity
Approvals Required
Workflow Failures
Cost

The dashboard must answer:

1. Where are we?
2. What is working?
3. What needs attention?
4. What should happen next?

Gate

A user can see the revenue workflow as business outcomes, not just technical activity.

---

25. PHASE 18 — AGENT SYSTEM

Only after the core deterministic workflow works should the specialized agent layer expand.

Initial agents

Strategy Agent
Market Intelligence Agent
Account Research Agent
Prospect Discovery Agent
Qualification Agent
Personalization Agent
Conversation Agent
Follow-up Agent
Meeting Agent
CRM Agent
Analytics Agent
Optimization Agent

Agent requirements

Every production agent must define:

Agent ID
Version
Purpose
Inputs
Outputs
Tools
Permissions
Memory Access
Approval Requirements
Cost Limits
Evaluation Metrics
Status

Agent states

Draft
Testing
Approved
Production
Paused
Disabled
Archived

---

26. PHASE 19 — AGENT EVALUATION

Objective

Prevent fluent but unreliable agents from entering production.

Measure:

- task success
- accuracy
- relevance
- hallucination rate
- tool-call correctness
- qualification accuracy
- personalization quality
- response classification accuracy
- cost
- latency
- failure rate
- human override rate
- business outcome

Gate

Production agents require evaluation evidence.

---

27. PHASE 20 — AGENT TRACE & OBSERVABILITY

Every production workflow should expose:

Agent
↓
Decision
↓
Tool Call
↓
Evidence
↓
Result
↓
Approval
↓
External Action

Track:

- execution time
- model usage
- token usage
- tool calls
- errors
- retries
- approvals
- external actions
- cost

Critical rule

Never silently pretend an action succeeded.

---

28. PHASE 21 — OPTIMIZATION ENGINE

After sufficient real workflow data exists, implement optimization.

Compare:

- audiences
- messages
- signals
- channels
- timing
- qualification rules
- follow-up sequences
- offers

The system should answer:

What worked?
What failed?
Where is conversion dropping?
What should be tested?
What is the likely impact?

Optimization must be:

- measurable
- reversible
- auditable

---

29. PHASE 22 — EXPERIMENT ENGINE

Support controlled experiments.

Example:

Experiment:
Message A vs Message B

Metric:
Positive Reply Rate

Population:
Qualified SaaS founders

Duration:
14 days

Track:

- sample size
- conversion
- confidence
- cost
- revenue impact

Do not claim a winning experiment when evidence is insufficient.

---

30. PHASE 23 — CRM INTEGRATIONS

Only after the core revenue loop works.

Potential systems:

- CRM
- calendar
- email
- Slack
- GitHub
- approved data providers

Integration architecture must use clear permission scopes and standardized adapter interfaces.

Do not hard-code the entire product around one vendor.

---

31. PHASE 24 — WORKFLOW ENGINE

Create a generalized workflow model.

Example:

Trigger
   ↓
Research
   ↓
Condition
   ↓
Agent
   ↓
Approval
   ↓
Action
   ↓
Wait
   ↓
Condition
   ↓
Agent

Workflow execution must support:

- state
- retries
- pauses
- approvals
- stop conditions
- failure handling
- observability
- audit events

---

32. PHASE 25 — AGENT FACTORY

Allow users to define an agent through natural language.

Example:

Create an agent that finds software companies
hiring customer-support staff and identifies
companies that may need AI support automation.

The generated agent definition should include:

Purpose
Trigger
Inputs
Tools
Data Sources
Instructions
Rules
Actions
Approval Policy
Stop Conditions
Evaluation Criteria

Generated agents must begin in:

"Testing"

They must not automatically become production agents.

---

33. PHASE 26 — SDK & CLI

Create developer tooling only after the underlying APIs stabilize.

Potential CLI:

dealora init
dealora agent create
dealora agent test
dealora workflow create
dealora workflow run
dealora logs
dealora evaluate

Potential SDK:

Agent
Workflow
Tool
Evaluation
Execution
Policy

Do not prematurely lock public APIs before real developer testing.

---

34. PHASE 27 — OPEN-SOURCE DISTRIBUTION

Open source should function as a growth mechanism.

Potential open-source components:

- agent schemas
- workflow engine
- agent SDK
- CLI
- selected integrations
- evaluation tooling
- developer examples
- skill format
- local development tools

Potential cloud components:

- managed execution
- hosted memory
- advanced analytics
- team controls
- enterprise governance
- premium integrations
- managed connectors
- marketplace infrastructure

The open-source/cloud boundary must be intentional.

---

35. PHASE 28 — MARKETPLACE

Marketplace is a later-stage feature.

Possible marketplace items:

Agent
Skill
Workflow
Integration
Template
Playbook
Evaluation Pack

Marketplace security requirements:

- permissions
- requested tools
- requested data
- actions
- external services
- network requirements
- risk classification
- security metadata
- versioning
- evaluation

Never execute an untrusted marketplace agent without explicit controls.

---

36. PHASE 29 — ADVANCED GOVERNANCE

Implement:

- RBAC
- approval policies
- tool permissions
- tenant isolation
- cost limits
- action limits
- kill switch
- audit trails
- retention rules
- deletion
- export
- data access controls

Governance is part of the product, not a last-minute enterprise feature.

---

37. PHASE 30 — SECURITY HARDENING

Before serious production expansion verify:

Authentication

- secure authentication
- session handling
- credential protection

Authorization

- tenant isolation
- least privilege
- role-based access

Data

- encryption where appropriate
- secure secret storage
- deletion controls
- retention controls

Agents

- tool permissions
- action policies
- cost limits
- runtime isolation

External systems

- scoped credentials
- rate limits
- failure handling
- audit logs

Abuse

- opt-out
- frequency limits
- anti-spam
- abuse monitoring
- rate limiting

---

38. PHASE 31 — PRODUCT QUALITY GATES

Every meaningful feature must pass:

Functional Test
      ↓
Security Test
      ↓
Agent Evaluation
      ↓
Cost Test
      ↓
Failure Test
      ↓
Permission Test
      ↓
User Experience Test

Do not call a feature complete only because the happy path works.

---

39. PHASE 32 — PILOT RELEASE

The first pilot should focus on a small number of real B2B service businesses.

Primary objective:

1 real business
↓
1 complete revenue workflow
↓
measurable opportunity
↓
willingness to pay

Measure:

- activation
- time to first qualified opportunity
- meeting creation
- workflow completion
- agent success
- human intervention
- cost
- customer-reported value
- willingness to pay

---

40. PHASE 33 — PRODUCT VALIDATION

Before expanding the feature set, validate:

Problem

Do businesses already spend meaningful time/money on:

- research
- prospecting
- qualification
- follow-up
- CRM administration

Product

Does DEALORA reduce this work without reducing quality?

Economics

Is customer value greater than:

- infrastructure cost
- model cost
- data cost
- support cost

Outcome

Does DEALORA improve measurable pipeline outcomes?

---

41. PHASE 34 — LONG-TERM PLATFORM

After the core product proves itself, evolve toward:

DEALORA
   ↓
Revenue Intelligence
   ↓
Agent Workforce
   ↓
Connected Business Systems
   ↓
Execution
   ↓
Measurement
   ↓
Optimization
   ↓
Revenue

Long-term capabilities may include:

- Revenue Autopilot
- coordinated AI sales team
- agent marketplace
- workflow marketplace
- developer platform
- enterprise governance
- self-hosting
- private deployments

---

42. IMPLEMENTATION ORDER

The default implementation order is:

PHASE 0
Repository Foundation

↓
PHASE 1
Application Foundation

↓
PHASE 2
Business Brain

↓
PHASE 3
Revenue Goal

↓
PHASE 4
Revenue Plan Compiler

↓
PHASE 5
Account / Prospect Input

↓
PHASE 6
Research Engine

↓
PHASE 7
Evidence System

↓
PHASE 8
Qualification

↓
PHASE 9
Personalization

↓
PHASE 10
Approval

↓
PHASE 11
First Outbound Integration

↓
PHASE 12
Conversation

↓
PHASE 13
Meeting Workflow

↓
PHASE 14
Next Best Action

↓
PHASE 15
Revenue Graph

↓
PHASE 16
Cost Engine

↓
PHASE 17
Dashboard

↓
PHASE 18
Agent System

↓
PHASE 19
Agent Evaluation

↓
PHASE 20
Observability

↓
PHASE 21
Optimization

↓
PHASE 22
Experiments

↓
PHASE 23
CRM Integrations

↓
PHASE 24
Workflow Engine

↓
PHASE 25
Agent Factory

↓
PHASE 26
SDK / CLI

↓
PHASE 27
Open Source Distribution

↓
PHASE 28
Marketplace

↓
PHASE 29+
Governance / Enterprise / Platform

---

43. MVP DEFINITION OF DONE

DEALORA MVP is considered functional only when this can happen:

User
 ↓
Creates Business Profile
 ↓
Defines Revenue Goal
 ↓
Defines ICP
 ↓
Adds Target Accounts
 ↓
Research Agent Runs
 ↓
Evidence Collected
 ↓
Prospects Qualified
 ↓
Score Explained
 ↓
Personalized Draft Created
 ↓
Human Approval
 ↓
Approved Action Executed
 ↓
Response Received
 ↓
Response Classified
 ↓
Meeting Recommended
 ↓
Meeting Recorded
 ↓
Dashboard Updated
 ↓
Cost Recorded
 ↓
Audit Trail Available

The MVP must answer:

What happened?
Why did it happen?
What evidence supported it?
What did it cost?
What should happen next?

---

44. NORTH STAR METRIC

Primary metric:

Qualified Revenue Opportunities Created per Active Workspace

Supporting metrics:

- qualified opportunities
- positive conversations
- meetings
- pipeline created
- customers
- attributed revenue
- cost per opportunity
- time to first value
- retention
- expansion

Do not optimize the product around:

- messages sent
- tokens consumed
- agent runs
- raw lead count

These are activity metrics, not customer outcomes.

---

45. AGENT EXECUTION RULES

Any coding agent working on DEALORA must follow these rules.

Rule 1

Read:

DEALORA_BLUEPRINT.md
ROADMAP.md

before making architecture decisions.

Rule 2

Inspect existing code before creating new abstractions.

Rule 3

Do not duplicate functionality.

Rule 4

Prefer small composable modules.

Rule 5

Keep domain logic independent from UI whenever practical.

Rule 6

Separate:

Business Logic
Agent Logic
Tool Logic
Integration Logic
Persistence
UI

Rule 7

Never hard-code secrets.

Rule 8

Never bypass platform restrictions.

Rule 9

Never fabricate evidence.

Rule 10

Never claim an external action succeeded unless the system has verified success.

Rule 11

External side effects must pass the correct approval/policy layer.

Rule 12

Every new agent needs evaluation criteria.

Rule 13

Every consequential action needs an audit trail.

Rule 14

Every major workflow needs failure handling.

Rule 15

Every feature should have tests.

---

46. AGENT WORK STYLE

When implementing a phase:

Step 1

Read the relevant section of:

DEALORA_BLUEPRINT.md
ROADMAP.md

Step 2

Inspect the repository.

Step 3

Identify dependencies.

Step 4

Implement the smallest complete slice.

Step 5

Add tests.

Step 6

Run:

lint
typecheck
tests
build

Step 7

Review security and permission implications.

Step 8

Update documentation.

Step 9

Only then move to the next phase.

---

47. CHANGE MANAGEMENT

Major architecture changes must be evaluated against:

Customer Value
Revenue Potential
Complexity
Security
Reliability
Distribution
Economics
Long-Term Moat

Do not rewrite working architecture without a concrete reason.

Prefer:

Incremental Change
+
Tests
+
Migration Path

over:

Large Rewrite

---

48. GITHUB COMMIT PRINCIPLE

Commits should be small and understandable.

Examples:

feat: add workspace model
feat: add revenue goal schema
feat: add evidence service
feat: add qualification engine
feat: add approval workflow
feat: add account research pipeline
test: add qualification evaluation suite
fix: prevent duplicate prospect creation
docs: update implementation roadmap

Avoid vague commit messages such as:

update
changes
fix stuff
misc

---

49. BRANCHING PRINCIPLE

Use focused branches for substantial work.

Example:

main
│
├── feat/foundation
├── feat/business-brain
├── feat/revenue-goal
├── feat/research-engine
├── feat/evidence
├── feat/qualification
├── feat/approval
└── feat/outbound-integration

Keep "main" buildable.

---

50. DEFINITION OF A SAFE AGENT

A production DEALORA agent must have:

Known Purpose
Known Inputs
Known Outputs
Known Tools
Known Permissions
Known Data Access
Known Cost Limits
Known Stop Conditions
Known Evaluation Metrics
Known Failure Behavior
Known Audit Trail

If any of these are unknown, the agent should remain in testing.

---

51. DEFINITION OF A SAFE WORKFLOW

A production workflow must have:

Trigger
Inputs
State
Actions
Approval Policy
Permissions
Stop Conditions
Retry Rules
Failure Handling
Audit Trail
Metrics
Cost Tracking

---

52. DEFINITION OF A TRUSTWORTHY OUTPUT

A trustworthy DEALORA output should make it possible to distinguish:

FACT
INFERENCE
HYPOTHESIS
RECOMMENDATION

The system should not blur these categories.

---

53. DEFINITION OF A SUCCESSFUL PRODUCT

DEALORA succeeds when a real business can use it to reliably move from:

Business Goal
      ↓
Evidence
      ↓
Qualified Opportunity
      ↓
Human-approved Action
      ↓
Conversation
      ↓
Meeting
      ↓
Pipeline
      ↓
Revenue

and the system can explain the process.

---

54. FINAL BUILD PRIORITY

When deciding what to build next, use this order:

1. Revenue loop
2. Reliability
3. Evidence
4. Human control
5. Measurement
6. Security
7. Developer experience
8. Scale
9. Ecosystem
10. Advanced autonomy

Do not reverse this order merely because advanced features appear more impressive.

---

55. FINAL PRODUCT PRINCIPLE

DEALORA should not become:

Another chatbot
Another CRM
Another email writer
Another scraper
Another generic agent framework

DEALORA should become:

A measurable
evidence-backed
permission-controlled
AI revenue execution system

The product architecture must continuously reinforce:

GOAL
+
CONTEXT
+
EVIDENCE
+
AGENTS
+
TOOLS
+
POLICIES
+
HUMAN CONTROL
+
MEASUREMENT
+
LEARNING
=
REVENUE EXECUTION

---

56. ROADMAP COMPLETION STANDARD

This roadmap is not complete merely because all files and modules exist.

A phase is complete only when its capability is:

- implemented
- tested
- observable
- secure enough for its scope
- documented
- integrated into the product loop
- validated against the phase gate

The goal is not to maximize code.

The goal is to create a working revenue system.

---

57. SOURCE-OF-TRUTH HIERARCHY

When documents or implementation ideas conflict, use this hierarchy:

1. Security / Safety Constraints
2. Explicit Product Requirements
3. DEALORA_BLUEPRINT.md
4. ROADMAP.md
5. Existing Architecture
6. Implementation Convenience
7. New Feature Ideas

A lower-level item must not silently override a higher-level requirement.

---

58. FINAL COMMAND FOR IMPLEMENTATION AGENTS

When an AI coding agent starts work on DEALORA:

READ THE BLUEPRINT.
READ THE ROADMAP.
INSPECT THE REPOSITORY.
IDENTIFY THE CURRENT PHASE.
IMPLEMENT ONLY THE NEXT REQUIRED SLICE.
TEST IT.
VERIFY SECURITY.
VERIFY FAILURE HANDLING.
VERIFY PERMISSIONS.
UPDATE DOCUMENTATION.
THEN CONTINUE.

Do not skip phases without a documented reason.

Do not invent architecture that conflicts with the blueprint.

Do not build future platform features before the core revenue loop works.

---

FINAL ROADMAP OBJECTIVE

The ultimate implementation target is:

User
 ↓
Business Context
 ↓
Revenue Goal
 ↓
Revenue Plan
 ↓
Evidence
 ↓
Opportunity Discovery
 ↓
Qualification
 ↓
Personalization
 ↓
Approval
 ↓
Execution
 ↓
Conversation
 ↓
Meeting
 ↓
Opportunity
 ↓
Revenue
 ↓
Measurement
 ↓
Learning
 ↓
Optimization

DEALORA is complete only when this loop works as a real, measurable system.
