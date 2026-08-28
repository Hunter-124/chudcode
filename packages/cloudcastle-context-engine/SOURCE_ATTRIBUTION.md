# Design pattern source attribution

This package is an original TypeScript implementation. It copies no third-party source code. The following public designs informed its boundaries and tests (references reviewed 2026-08-27).

## LangGraph: checkpoint and store separation

- Source: [LangGraph persistence documentation](https://docs.langchain.com/oss/python/langgraph/persistence)
- Borrowed pattern: keep lifecycle-scoped state separate from externally retrieved durable knowledge. Here, the backend keeps only the last session prompt block in a `WeakMap`; authoritative incident data remains in CloudCastle control-api and is fetched again through the backend lifecycle hook.
- Deliberate difference: this package implements neither a checkpointer nor a general memory store.

## Microsoft GraphRAG: evidence classes, context allocation, and provenance

- Sources: [GraphRAG local search](https://microsoft.github.io/graphrag/query/local_search/) and [GraphRAG default dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/)
- Borrowed pattern: preserve distinct evidence classes and their source relationships instead of flattening everything into one score; prioritize candidates and bound the context window. This package independently ranks each configured class, merges class queues in deterministic rounds, and carries source URL, timestamp, entity, and provenance into every rendered record.
- Deliberate difference: there is no graph index, embedding search, community summary, or LLM-generated claim extraction. Control-api records remain untrusted source evidence.

## LlamaIndex: priority-aware token truncation

- Source: [LlamaIndex memory documentation](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/memory/)
- Borrowed pattern: assign explicit priorities and truncate lower-priority material to keep memory within a fixed token limit. This package admits independently ranked records against a fixed conservative character/token estimate and truncates only the content of the last admitted record while retaining its attribution metadata.
- Deliberate difference: the model cannot page or mutate these memory blocks, and no tokenizer package is required at runtime.

## Haystack and LlamaIndex: retrieval evaluation contracts

- Sources: [Haystack evaluation](https://docs.haystack.deepset.ai/docs/evaluation), [Haystack ContextRelevanceEvaluator](https://docs.haystack.deepset.ai/docs/contextrelevanceevaluator), [LlamaIndex answer and context relevancy evaluation](https://developers.llamaindex.ai/python/examples/evaluation/answer_and_context_relevancy/), and [LlamaIndex faithfulness evaluation](https://developers.llamaindex.ai/typescript/framework/modules/evaluation/faithfulness/)
- Borrowed pattern: test retrieval quality and groundedness as observable contracts rather than testing internal plumbing. Package tests assert class relevance/order, coverage, provenance, redaction, boundedness, and fail-closed behavior. Those deterministic checks are suitable prerequisites for a later corpus-level context-relevance or answer-faithfulness evaluation.
- Deliberate difference: no evaluator makes an LLM call in this runtime package, so evaluation cannot leak incident evidence or credentials to another provider.

## MemGPT: bounded paging model

- Source: Packer et al., [“MemGPT: Towards LLMs as Operating Systems”](https://arxiv.org/abs/2310.08560)
- Borrowed pattern: treat the model context as scarce active memory and external data as a separately bounded tier. The control-api is the external tier; a single ranked incident page is admitted for one turn, and the complete remote response is never placed in the prompt.
- Deliberate difference: the model receives no paging or action tools. Retrieval is host-controlled, read-only, endpoint-capped, and tied to an explicit incident UUID.
