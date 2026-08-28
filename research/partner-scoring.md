# Stage 1 — Channel-partner scoring rubric

Sibling to `adjacency-scoring.md`, not a replacement. That rubric asks **"would
this company buy a retrieval assistant for its own content?"** This one asks
**"would this company put our assistant in front of its own customers?"** — the
multiplier question. A company can score well on one and badly on the other,
and collapsing them into a single number loses exactly the distinction that
makes a partner worth pursuing.

Each prospect is scored 0–5 on four signals; weighted total 0–100.

| Signal | Weight | 5 looks like | 0 looks like |
| --- | --- | --- | --- |
| **Reach into our buyers** | 30% | Serves many businesses that each have a content library — an agency, a CMS/hosting platform, a vertical SaaS with hundreds of customers who publish | Sells to consumers, or to a handful of enterprises |
| **Integration surface** | 30% | Already has a marketplace, app directory, plugin ecosystem, or public API where a partner can ship something customers install themselves | Closed product, no extension points, integrations are bespoke professional services |
| **AI intent, revealed not announced** | 25% | Ships AI features their customers use, hires AI engineers, publishes AI docs/changelog entries — evidence of *building*, dated | A press release, an "AI-powered" tagline, a waitlist |
| **Partner motion exists** | 15% | Has a partner/reseller programme, published revenue share, or solutions directory — a door that is already open | No partner concept; every deal is a bespoke negotiation |

Score bands: **≥75** approach as a partner now · **60–74** approach after a
gate review · **40–59** nurture · **<40** drop.

## Notes, and the traps

- **"AI intent" must be revealed preference, dated.** Everything markets itself
  as AI-powered; that is worth 0 here. What counts is evidence they have
  *shipped*: a changelog entry, AI documentation, an engineering job posting, a
  model-provider dependency. Score the artefact, and record its URL and date in
  `rationale` — a claim with no link is not evidence.
- **A partner's own site is often thin, and that is not disqualifying here.**
  `adjacency-scoring.md` weights public-data richness at 30% because the demo is
  built FROM the prospect's content. A great channel partner may be a product
  company with 20 marketing pages. Score their **documentation** as the demo
  corpus instead — dev-tool and SaaS companies clear the 25-page floor on docs
  even when their marketing site cannot.
- **Reach is about their customers' content, not their own.** A hosting company
  with 10,000 customers who each publish is a bigger multiplier than a large
  company that publishes nothing.
- **A partner is not automatically a customer.** Score them here, and if you
  also want them as a direct buyer, score them there separately. Do not average
  the two — a company that is a superb partner and a poor customer should read
  as exactly that, not as mediocre at both.
- **Beware the competitor overlap.** A company shipping its own retrieval
  assistant scores 5 on AI intent and may be a competitor rather than a channel.
  Note it in `rationale`; it is a judgement for a human at the gate, not
  something the score should silently resolve.
