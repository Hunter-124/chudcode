# image_analyze

> Inspect and transform images with the optional native `chud-vision` sidecar.

## Source
- Entry: `packages/coding-agent/src/tools/image-analyze.ts`
- Native client: `packages/coding-agent/src/tools/vision/sidecar.ts` and `crates/chud-vision`

## Inputs
`action` selects `describe`, `classify`, `detect`, `ocr`, `redact`, `crop`, `locate`, or `diff`. `path` is required; `diff` also needs `path_b`. `locate` accepts OCR `query` or a template path. `bbox` is `[x,y,width,height]`. Redaction flags select faces, emails, phones, cards, keys, or all text. `attach` controls processed-image attachment and `max_results` bounds returned families.

## Behavior
The tool resolves workspace paths and internal image URLs, calls the native sidecar, and returns bounded structured detections plus human-readable text. Expected sidecar/model absence is reported honestly as unavailable; it never fabricates detections. Redact, crop, and diff attach their processed output by default.

## Side effects and limits
Read actions do not mutate source images. Transform actions create a separate processed artifact. Paths remain workspace-scoped, result families are capped, and large images are bounded by the shared image-loading policy.