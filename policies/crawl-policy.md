# Crawl Policy

The output of every crawl is shown back to the company that was crawled, so
the bar is "would we be comfortable walking them through exactly how we got
this data." All crawls run through `divinci rag crawl` under these rules:

1. **robots.txt is honored.** Disallowed paths are never fetched, including
   by the agentic source-research step.
2. **Rate limit:** max 1 request/second per host, identified user-agent
   (`DivinciDemoBot`) with a contact URL.
3. **Page budget:** hard cap per run, set in the corpus manifest
   (default 500 pages). The orchestrator enforces it.
4. **Exclusions:** anything behind auth, user-generated content (forums,
   reviews), third-party embeds, and pages whose terms prohibit scraping.
5. **Provenance log:** every fetched URL is recorded in the run log under
   `runs/`, with timestamp and destination (which RAG vector).
6. **Takedown:** if a prospect objects, the workspace and all derived
   vectors are deleted (`divinci workspace delete`) and the run log is
   annotated — same day.
