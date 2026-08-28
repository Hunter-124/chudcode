# Chudcode Desktop third-party notices

This manifest covers the **15 direct package/toolchain entries** used by the Chudcode desktop browser UI and its local Bun runtime: 13 production dependencies, the directly used `@types/d3` development package, and Bun. Versions and licenses were verified from the checked-in catalog, installed package metadata, the packages' license files, and (for Bun) the upstream Bun license manifest.

The built web bundle contains JavaScript, CSS, fonts/workers, or SVG data from some of these packages. Source and binary distributions must keep this file with the application. The current `bun run build` script does not copy notices automatically; a release packager **must** install this file as `THIRD_PARTY_NOTICES.md` (or an equivalently visible application `licenses/` file) next to the distributed desktop artifacts.

## Direct dependency manifest

| Package | Version | SPDX / catalog notice | Source | Use in Chudcode desktop | Source and binary redistribution obligation | Upstream notice in a source checkout |
| --- | ---: | --- | --- | --- | --- | --- |
| Monaco Editor (`monaco-editor`) | 0.56.0 | MIT | <https://github.com/microsoft/monaco-editor> | Code editor, language workers, models, navigation, and editor state | Preserve Microsoft's copyright and MIT text in source copies and with bundles containing Monaco or its workers. | `node_modules/monaco-editor/LICENSE` |
| xterm.js (`@xterm/xterm`) | 6.0.0 | MIT | <https://github.com/xtermjs/xterm.js> | Browser terminal emulator and xterm CSS | Preserve all xterm.js/SourceLair/Christopher Jeffrey copyright lines and the MIT text in source and binary distributions. | `node_modules/@xterm/xterm/LICENSE` |
| xterm.js fit addon (`@xterm/addon-fit`) | 0.11.0 | MIT | <https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit> | Fits terminal rows and columns to its panel | Preserve the xterm.js authors' copyright and MIT text in source and binary distributions. | `node_modules/@xterm/addon-fit/LICENSE` |
| D3 (`d3`) | 7.9.0 | ISC | <https://github.com/d3/d3> | SVG graph layout types, drag, selection, and zoom behavior | Preserve Mike Bostock's copyright and ISC permission notice in every source or bundled copy. | `node_modules/d3/LICENSE` |
| D3 TypeScript declarations (`@types/d3`) | 7.4.3 | MIT | <https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/d3> | Compile-time D3 declarations; erased from the browser bundle | No binary notice is required when the declarations are absent. Preserve the Microsoft copyright and MIT text if source or declaration files are redistributed. | `node_modules/@types/d3/LICENSE` |
| Lucide React (`lucide-react`) | 1.34.0 | ISC; Feather-derived catalog icons carry MIT | <https://github.com/lucide-icons/lucide/tree/main/packages/lucide-react> | React SVG icon catalog used throughout the shell, editor, Git, graph, terminal, and status UI | Preserve the Lucide ISC notice and the embedded Feather icon list/MIT notice with source or bundled icons. The complete current catalog notice is reproduced below. | `node_modules/lucide-react/LICENSE` |
| React (`react`) | 19.2.7 | MIT | <https://github.com/facebook/react> | UI component and hook runtime | Preserve Meta's copyright and MIT text in source and binary distributions. | `node_modules/react/LICENSE` |
| React DOM (`react-dom`) | 19.2.7 | MIT | <https://github.com/facebook/react/tree/main/packages/react-dom> | Browser DOM root and rendering runtime | Preserve Meta's copyright and MIT text in source and binary distributions. | `node_modules/react-dom/LICENSE` |
| OMP collaboration UI (`@oh-my-pi/collab-web`) | 16.3.6 workspace source | MIT | <https://github.com/can1357/oh-my-pi/tree/main/packages/collab-web> | Reused session client, composer, transcript, agent panels/drawer, header, banners, toasts, and base presentation styles | Preserve the Oh My Pi root MIT notice when its source, styles, or bundled presentation code are distributed. | Repository `LICENSE` (`../../LICENSE` from this package) |
| OMP coding-agent runtime (`@oh-my-pi/pi-coding-agent`) | 18.0.8 | MIT | <https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent> | Agent sessions, extension initialization, registry, lifecycle, theme, stored sessions, and LSP contracts | Preserve the Oh My Pi root MIT notice in source and binary distributions. | Repository `LICENSE` (`../../LICENSE`) |
| OMP AI contracts/runtime (`@oh-my-pi/pi-ai`) | 18.0.8 | MIT | <https://github.com/can1357/oh-my-pi/tree/main/packages/ai> | Model and image-content contracts used by desktop session adaptation | Preserve the Oh My Pi root MIT notice whenever included source or runtime code is distributed. Type-only imports do not add emitted browser code. | Repository `LICENSE` (`../../LICENSE`) |
| OMP native bindings (`@oh-my-pi/pi-natives`) | 18.0.8 | MIT | <https://github.com/can1357/oh-my-pi/tree/main/packages/natives> | Local PTY/process and workspace glob operations | Preserve the Oh My Pi root MIT notice with JavaScript, declaration, and native binary distributions. Native release packaging must also retain the notices for libraries actually linked into that release artifact. | Repository `LICENSE` (`../../LICENSE`) |
| OMP wire contracts (`@oh-my-pi/pi-wire`) | 18.0.8 | MIT | <https://github.com/can1357/oh-my-pi/tree/main/packages/wire> | Shared session, transcript, UI response, and event wire types | Preserve the Oh My Pi root MIT notice if source or emitted runtime code is redistributed. Type-only imports do not add emitted browser code. | Repository `LICENSE` (`../../LICENSE`) |
| OMP utilities (`@oh-my-pi/pi-utils`) | 18.0.8 | MIT | <https://github.com/can1357/oh-my-pi/tree/main/packages/utils> | Project/agent paths, error guards, records, process-tree, and shared runtime helpers | Preserve the Oh My Pi root MIT notice in source and binary distributions. | Repository `LICENSE` (`../../LICENSE`) |
| Bun runtime and build tool | 1.4.0 repository toolchain pin | Bun code: MIT. A Bun executable is an aggregate containing LGPL-2.0-family and other separately licensed components; it must not be labeled MIT-only. | <https://github.com/oven-sh/bun> | Builds the browser/server bundles and runs the local HTTP/WebSocket server | The present build emits JavaScript/assets and does **not** copy a Bun executable, so Bun's binary obligations are not triggered by those artifacts. If a release redistributes Bun, it must ship that exact version's complete upstream `LICENSE.md` and linked third-party notices and meet the stated JavaScriptCore/WebKit and TinyCC LGPL relinking requirements. Put that unmodified manifest at `licenses/bun/LICENSE.md`; this summary is not a substitute. | Upstream `LICENSE.md`: <https://github.com/oven-sh/bun/blob/main/LICENSE.md> |

The OMP package entries above are internal workspace packages, but they remain attributed to their upstream Oh My Pi authors and contributors under the repository MIT license. This desktop package does not relicense them.

## Included license notices

The following notices are included so a packaged copy of this file satisfies the direct MIT/ISC notice requirements. Package-specific upstream files remain authoritative.

### Monaco Editor — MIT

Copyright (c) 2016 - present Microsoft Corporation

### xterm.js — MIT

Copyright (c) 2017-2019, The xterm.js authors (<https://github.com/xtermjs/xterm.js>)  
Copyright (c) 2014-2016, SourceLair Private Company (<https://www.sourcelair.com>)  
Copyright (c) 2012-2013, Christopher Jeffrey (<https://github.com/chjj/>)

### xterm.js fit addon — MIT

Copyright (c) 2019, The xterm.js authors (<https://github.com/xtermjs/xterm.js>)

### D3 TypeScript declarations — MIT

Copyright (c) Microsoft Corporation.

### React and React DOM — MIT

Copyright (c) Meta Platforms, Inc. and affiliates.

### Oh My Pi packages — MIT

Copyright (c) 2025 Mario Zechner  
Copyright (c) 2025-2026 Can Bölük  
Copyright (c) 2026 Stencil Labs, Inc.

### MIT permission and warranty text

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### D3 — ISC

Copyright 2010-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

### Lucide React catalog — ISC and Feather MIT

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Product boundary and release status

Chudcode desktop contains **no CAD proprietary assets, CAD source code, CAD runtime, CAD protocol, or CAD-derived presentation resources**. It is a direct Oh My Pi/Chudcode browser shell over the local Chudcode runtime.

For the direct scope recorded here, unresolved license obligations: **0**. A ship-ready package must include this file. A package that additionally embeds a Bun executable must also include Bun's complete, version-matched license bundle and LGPL compliance materials as described above; the current JavaScript/assets build does not embed Bun.
