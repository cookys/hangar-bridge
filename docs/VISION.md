# Fleet Vision & Design Intent — "the second cookys"

> **Status**: Intent-layer (R0), pre-technology. This captures *what cookys is trying to
> build and why*, surfaced through a Socratic conversation 2026-06-27. It deliberately
> does **not** choose tech (transport, broker, language) — that is the explicitly-deferred
> direction (2). This doc is direction (1): get the intent clear first.
> **Canvas note**: the vision is fleet-/cookys-wide; hangar-bridge is one organ of it.
> This doc lives here because the conversation started here and it reframes hangar-bridge's
> purpose, but it may be promoted to `homeLab` (design) or `hangar` (ops) later.

---

## 0. North star

**Replicate cookys's working self so it runs while he sleeps — and use compute to run it
in parallel.**

The real bottleneck today is **cookys himself**: he is the scheduler/arbiter in the loop —
he manually allocates homelab resources for the Claude Code agents, decides who interrupts
whom, what runs when. This is serial, and it stops when he sleeps. He has **too many
interests** to pursue one at a time.

The goal is not a product and not "one assistant". It is **personal leverage**: pull cookys
out of the loops, make his *behavior* (judgment, coordination, design, coding, learning)
**copyable**, and then spend **compute** to run **many copies in parallel**, each advancing
a different front of his curiosity. Open-sourcing a sanitized version is fine if someone
wants it, but it is incidental — the point is to multiply one curious mind with compute.

> **Bottleneck migration (the key force).** Today's bottleneck = cookys's serial attention.
> Once replication works, the bottleneck **moves** to the **homelab's finite compute** — N
> copies of cookys contend for the same GPUs. This is *why* fleet resource-arbitration is the
> keystone, not a side feature (see §3).

## 1. The replicated cognitive loop (a working metaphor — hold loosely)

cookys's framing: these are projects he has *imagined* and is interested in; casting them as
"organs" is a lens offered in conversation, useful but disposable, not his canonical model.

| Project | Faculty (lens) |
|---------|----------------|
| **mnemos** | memory / identity — who he is, what he knows, background |
| **nikki** | perception + reflection — crawl the world, aggregate links back to the brain, trigger actions (journaling = self-reflection) |
| **homeLab** | design cognition — architecture-level reasoning / design discussion |
| **autopilot** | hands (coding) — the dev loop |
| **hangar** | hands (ops) — actually operating the fleet |
| **codeforge** | learning loop — extract knowledge from doing → back into mnemos |
| **hangar-bridge** | autonomic nervous system — let the organs negotiate & schedule shared homelab resources **without cookys as the arbiter** |

Assembled, this is a closed, self-turning loop: **perceive (nikki) → remember (mnemos) →
design (homeLab) → act (autopilot/hangar) → coordinate resources (hangar-bridge) → learn
back (codeforge)** — running while the human is offline.

## 2. Epistemic posture as a first-class replicated property

A clone that only executes cookys's decisions is **not** cookys. In real life cookys
**updates his views when given evidence-backed professional advice, and discusses humbly**.
That disposition — *willing to be refuted by a good argument + documented evidence* — must
be reproduced **inside** the loop, not left in the human.

⇒ The adversarial **review loop is the mechanism that replicates this trait**. Running this
very doc through `/l5` loop review (reviewers challenging it with evidence, the author
revising humbly) is the trait dogfooding itself. Any future component that "decides" must
also be challengeable-by-evidence, or the replica drifts away from being cookys.

## 2.5 Model-heterogeneous by design (the MCP choice)

hangar-bridge was built as **MCP on purpose**: so that **any SOTA model that speaks MCP can
install the peer-agent and participate** — it is *not* Claude-Code-locked. The clones are
**model-agnostic**: a fleet member can be Claude, Gemini, GPT, or whatever is best/available.

This heterogeneity is **already realized at the autopilot layer** via **per-box headless logins
of multiple SOTA models** (the same decorrelated-engine path used for `/l5` hetero dispatch).

Two reasons it matters to the north star:
- **Portability** — the replica is not hostage to one vendor; "the second cookys" can run on
  whatever model is cheapest/strongest/available per task.
- **Decorrelation as a quality lever** — different model families have different blind spots.
  This directly feeds §2's "challenge me with evidence": a Gemini can refute a Claude and vice
  versa. Part of *"act like me **and better**"* comes from picking the right model per task and
  **cross-model checking**, not from any single model being cookys.

⇒ Implication for "what a clone is" (§5): a clone may be better modeled as a **role/loop that
any capable model can fill**, not a fixed model instance.

## 3. hangar-bridge's role — autonomic resource arbitration

Not a chat relay, not a job queue at heart: a **fleet resource-negotiation / arbitration
fabric**. Future shape: **one "central-control Claude Code" per fleet** that is simultaneously
(a) the unified outward face and (b) the internal scheduler/coordinator; under it, per-box
workers report resource state and interruptibility.

**Canonical scenario (the unit of work the system must handle):** an RTX Pro 6000 is running
image generation; a large-language-model demand suddenly arrives. A coordinator requests with
metadata — *task size, priority, can-it-wait*. Fleet members report their own resource state
and whether they can be interrupted. Multi-round negotiation: `cookys-cuda` says "I can't
interrupt, ask someone else" → coordinator asks others → converges to an allocation
(`cookys-cuda`: "OK, I'll pause 5 minutes to help you"). The primitives this implies (capability/
state advertisement, priority+interruptibility requests, offer/counter-offer rounds, a binding
allocation) are what make it *not* fire-and-forget pub/sub.

## 4. Posture & semantics (confirmed in conversation)

- **Autonomy**: mostly agent-to-agent; **few human interventions**. The system must itself
  decide *what it can settle autonomously vs. what must wake cookys*. That **autonomy/escalation
  boundary is load-bearing** — an autonomic function has to keep running while consciousness
  (the human) is offline, like heartbeat/breathing, yet never do something irreversible
  unsupervised.
- **Topology**: hybrid — hub dispatch **and** peer-to-peer conversation coexist.
- **Delivery**: presence-aware; the sender must learn when a peer is offline. Whether a missed
  message is back-filled **depends on message type** (e.g. a dispatch may need backfill; chatter
  may not). Not blanket durable store-and-forward.

## 5. What is explicitly NOT yet decided (open intent questions)

- **Canvas boundary**: just hangar-bridge, the whole fleet (hangar+bridge+agents), or the whole
  cookys ecosystem (autopilot/codeforge/mnemos + fleet)? — *to be clarified together.*
- **What "a clone" concretely is**: many *specialized* copies vs. many *general* copies of cookys?
- **Success signal**: what state would cookys accept as "it works / I'm out of the loop"?
- **Clone identity & divergence**: do copies share one memory (mnemos) or fork? how is value/judgment
  drift prevented as copies run unsupervised?
- **Safety-while-asleep**: the concrete rules for the autonomy/escalation boundary.
- **Tech**: transport/broker/language (NATS vs Rust port vs custom vs keep-relay) — *direction (2),
  deliberately deferred until this intent converges.*

## 6. How to read this doc

This is the **intent contract**. Direction (2) — surveying technology against this intent — is
gated on this converging. The review loop's job right now is **not** to design tech; it is to
**interrogate the intent for depth and gaps** and answer: *where should cookys dig deeper before
any tech choice?*
