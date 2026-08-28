#include "editor/editor.h"

#include <TextEditor.h>
#include <imgui.h>

#include "theme/anim.h"
#include "theme/theme.h"

#include <algorithm>
#include <cassert>
#include <chrono>
#include <deque>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <utility>

#if __has_include("protocol/desktop_client.h")
#include "protocol/desktop_client.h"
#define CHUD_EDITOR_HAS_DESKTOP_CLIENT 1
#else
#define CHUD_EDITOR_HAS_DESKTOP_CLIENT 0
#endif

namespace chud::editor {
namespace {

struct DecodedCodePoint {
    std::uint32_t value = 0;
    std::size_t bytes = 0;
    bool valid = false;
};

DecodedCodePoint decodeUtf8(std::string_view text, std::size_t offset) noexcept {
    if (offset >= text.size()) return {};
    const auto first = static_cast<unsigned char>(text[offset]);
    if (first < 0x80U) return {first, 1, true};

    std::size_t bytes = 0;
    std::uint32_t value = 0;
    std::uint32_t minimum = 0;
    if ((first & 0xE0U) == 0xC0U) {
        bytes = 2; value = first & 0x1FU; minimum = 0x80U;
    } else if ((first & 0xF0U) == 0xE0U) {
        bytes = 3; value = first & 0x0FU; minimum = 0x800U;
    } else if ((first & 0xF8U) == 0xF0U) {
        bytes = 4; value = first & 0x07U; minimum = 0x10000U;
    } else {
        return {};
    }
    if (offset + bytes > text.size()) return {};
    for (std::size_t i = 1; i < bytes; ++i) {
        const auto next = static_cast<unsigned char>(text[offset + i]);
        if ((next & 0xC0U) != 0x80U) return {};
        value = (value << 6U) | (next & 0x3FU);
    }
    if (value < minimum || value > 0x10FFFFU || (value >= 0xD800U && value <= 0xDFFFU)) return {};
    return {value, bytes, true};
}


std::string_view lineAt(std::string_view text, std::size_t wanted) noexcept {
    std::size_t line = 0;
    std::size_t start = 0;
    while (start <= text.size()) {
        const auto end = text.find('\n', start);
        if (line == wanted) return text.substr(start, end == std::string_view::npos ? text.size() - start : end - start);
        if (end == std::string_view::npos) break;
        start = end + 1;
        ++line;
    }
    return {};
}

const TextEditor::Language* languageFor(std::string_view language) {
    if (language == "c") return TextEditor::Language::C();
    if (language == "cpp" || language == "c++") return TextEditor::Language::Cpp();
    if (language == "csharp" || language == "cs") return TextEditor::Language::Cs();
    if (language == "python") return TextEditor::Language::Python();
    if (language == "lua") return TextEditor::Language::Lua();
    if (language == "json" || language == "jsonc") return TextEditor::Language::Json();
    if (language == "markdown") return TextEditor::Language::Markdown();
    if (language == "sql") return TextEditor::Language::Sql();
    if (language == "glsl") return TextEditor::Language::Glsl();
    if (language == "hlsl") return TextEditor::Language::Hlsl();
    return nullptr;
}

ImU32 diagnosticColor(DiagnosticSeverity severity) {
    const auto& colors = ui::palette();
    switch (severity) {
        case DiagnosticSeverity::Error: return ui::toU32(colors.diagnosticError);
        case DiagnosticSeverity::Warning: return ui::toU32(colors.diagnosticWarn);
        case DiagnosticSeverity::Information:
        case DiagnosticSeverity::Hint: return ui::toU32(colors.diagnosticHint);
    }
    return ui::toU32(colors.diagnosticHint);
}

TextEditor::Palette vendorPalette() {
    const auto& colors = ui::palette();
    auto result = TextEditor::GetDarkPalette();
    const auto put = [&result](TextEditor::Color role, ImVec4 color) {
        result[static_cast<std::size_t>(role)] = ui::toU32(color);
    };
    put(TextEditor::Color::text, colors.text);
    put(TextEditor::Color::keyword, colors.secondary);
    put(TextEditor::Color::declaration, colors.accent);
    put(TextEditor::Color::number, colors.statusInfo);
    put(TextEditor::Color::string, colors.statusOk);
    put(TextEditor::Color::punctuation, colors.textDim);
    put(TextEditor::Color::preprocessor, colors.statusWarn);
    put(TextEditor::Color::identifier, colors.text);
    put(TextEditor::Color::knownIdentifier, colors.secondary);
    put(TextEditor::Color::comment, colors.textDim);
    put(TextEditor::Color::background, colors.codeBg);
    put(TextEditor::Color::cursor, colors.accent);
    put(TextEditor::Color::selection, colors.accentSelection);
    put(TextEditor::Color::whitespace, colors.editorGutterText);
    put(TextEditor::Color::matchingBracketBackground, colors.accentSoft);
    put(TextEditor::Color::matchingBracketActive, colors.accent);
    put(TextEditor::Color::matchingBracketLevel1, colors.secondary);
    put(TextEditor::Color::matchingBracketLevel2, colors.statusInfo);
    put(TextEditor::Color::matchingBracketLevel3, colors.statusWarn);
    put(TextEditor::Color::matchingBracketError, colors.statusErr);
    put(TextEditor::Color::lineNumber, colors.editorGutterText);
    put(TextEditor::Color::currentLineNumber, colors.accent);
    return result;
}

std::string tabLabel(const DocumentState& document) {
    const auto slash = document.uri.find_last_of("/\\");
    std::string label = slash == std::string::npos ? document.uri : document.uri.substr(slash + 1);
    if (document.dirty) label += " *";
    label += "###editor-tab-" + document.uri;
    return label;
}

#if CHUD_EDITOR_HAS_DESKTOP_CLIENT
std::uint64_t unsignedValue(const Json& value, const char* key) {
    const auto number = value.value(key, std::int64_t{0});
    return number > 0 ? static_cast<std::uint64_t>(number) : 0;
}

FileStamp parseStamp(const Json& value) {
    return {value.value("sha256", std::string{}), unsignedValue(value, "size"),
            unsignedValue(value, "mtimeNs"), unsignedValue(value, "generation")};
}

Position parsePosition(const Json& value) {
    const auto line = value.value("line", std::int64_t{0});
    const auto column = value.contains("column") ? value.value("column", std::int64_t{0})
                                                 : value.value("character", std::int64_t{0});
    return {line > 0 ? static_cast<std::size_t>(line) : 0,
            column > 0 ? static_cast<std::size_t>(column) : 0};
}

Range parseRange(const Json& value) {
    return {parsePosition(value.value("start", Json::object())),
            parsePosition(value.value("end", Json::object()))};
}

std::vector<Location> parseLocations(const Json& value) {
    std::vector<Location> locations;
    const auto append = [&locations](const Json& item) {
        if (!item.is_object()) return;
        const auto uri = item.contains("uri") ? item.value("uri", std::string{})
                                              : item.value("targetUri", std::string{});
        const auto range = item.contains("range") ? item["range"]
                          : item.value("targetSelectionRange", Json::object());
        if (!uri.empty() && range.is_object()) locations.push_back({uri, parseRange(range)});
    };
    if (value.is_array()) {
        for (const auto& item : value) append(item);
    } else {
        append(value);
    }
    return locations;
}

std::string hoverText(const Json& contents) {
    if (contents.is_string()) return contents.get<std::string>();
    if (contents.is_object()) return contents.value("value", std::string{});
    if (!contents.is_array()) return {};
    std::string result;
    for (const auto& item : contents) {
        const auto part = hoverText(item);
        if (part.empty()) continue;
        if (!result.empty()) result += "\n\n";
        result += part;
    }
    return result;
}

LspValue parseLspValue(LspFeature feature, const Json& value) {
    if (value.is_null()) return {};
    switch (feature) {
        case LspFeature::Definition:
        case LspFeature::References:
            return parseLocations(value);
        case LspFeature::Hover: {
            Hover hover;
            if (value.is_object()) {
                hover.markdown = hoverText(value.value("contents", Json{}));
                if (value.contains("range") && value["range"].is_object()) hover.range = parseRange(value["range"]);
            } else {
                hover.markdown = hoverText(value);
            }
            return hover;
        }
        case LspFeature::Completion: {
            const Json* items = &value;
            if (value.is_object() && value.contains("items")) items = &value["items"];
            std::vector<CompletionItem> result;
            if (items->is_array()) {
                result.reserve(items->size());
                for (const auto& item : *items) {
                    if (!item.is_object()) continue;
                    CompletionItem completion;
                    completion.label = item.value("label", std::string{});
                    completion.insertText = item.value("insertText", std::string{});
                    completion.detail = item.value("detail", std::string{});
                    if (completion.insertText.empty() && item.contains("textEdit") && item["textEdit"].is_object()) {
                        completion.insertText = item["textEdit"].value("newText", std::string{});
                    }
                    if (!completion.label.empty()) result.push_back(std::move(completion));
                }
            }
            return result;
        }
        case LspFeature::CodeAction: {
            std::vector<CodeAction> result;
            if (value.is_array()) {
                result.reserve(value.size());
                for (const auto& item : value) {
                    if (!item.is_object()) continue;
                    CodeAction action;
                    action.title = item.value("title", std::string{});
                    action.kind = item.value("kind", std::string{});
                    if (item.contains("data")) action.opaqueId = item["data"].dump();
                    if (!action.title.empty()) result.push_back(std::move(action));
                }
            }
            return result;
        }
    }
    return {};
}

RequestError responseError(const ResponseFrame& response) {
    if (response.error) return {response.error->code, response.error->message};
    return {"invalid-response", "Desktop protocol returned an invalid response"};
}

const char* lspMethod(LspFeature feature) {
    switch (feature) {
        case LspFeature::Definition: return "textDocument/definition";
        case LspFeature::References: return "textDocument/references";
        case LspFeature::Hover: return "textDocument/hover";
        case LspFeature::Completion: return "textDocument/completion";
        case LspFeature::CodeAction: return "textDocument/codeAction";
    }
    return "";
}
#endif

} // namespace

bool RequestError::isConflict() const noexcept {
    return code == "CONFLICT" || code == "conflict" || code == "cas-conflict" ||
           code == "stamp-mismatch" || code == "FILE_CHANGED" ||
           code == "WORKSPACE_WRITE_CONFLICT";
}

struct EditorPanel::Impl {
    struct CallbackQueue {
        std::mutex mutex;
        bool alive = true;
        std::deque<std::function<void(Impl&)>> callbacks;
    };

    EditorRequests requests;
    std::string workspace;
    std::unordered_map<std::string, DocumentState> documents;
    std::vector<std::string> tabs;
    std::string active;
    std::unordered_map<std::string, std::unique_ptr<TextEditor>> editors;
    std::shared_ptr<CallbackQueue> callbackQueue = std::make_shared<CallbackQueue>();
    std::function<void(LspFeature, Result<LspValue>)> lspHandler;
    std::string requestedTab;
    std::thread::id owner = std::this_thread::get_id();

    explicit Impl(EditorRequests value) : requests(std::move(value)) {}

    ~Impl() {
        std::lock_guard lock(callbackQueue->mutex);
        callbackQueue->alive = false;
        callbackQueue->callbacks.clear();
    }

    template <typename Function>
    void enqueue(Function&& function) {
        const std::weak_ptr<CallbackQueue> weak = callbackQueue;
        if (const auto queue = weak.lock()) {
            std::lock_guard lock(queue->mutex);
            if (queue->alive) queue->callbacks.emplace_back(std::forward<Function>(function));
        }
    }

    static void enqueueWeak(const std::weak_ptr<CallbackQueue>& weak, std::function<void(Impl&)> function) {
        if (const auto queue = weak.lock()) {
            std::lock_guard lock(queue->mutex);
            if (queue->alive) queue->callbacks.emplace_back(std::move(function));
        }
    }

    DocumentState* find(std::string_view uri) noexcept {
        const auto iterator = documents.find(std::string(uri));
        return iterator == documents.end() ? nullptr : &iterator->second;
    }

    const DocumentState* find(std::string_view uri) const noexcept {
        const auto iterator = documents.find(std::string(uri));
        return iterator == documents.end() ? nullptr : &iterator->second;
    }

    std::string target(std::string_view requested) const {
        return requested.empty() ? active : std::string(requested);
    }

    void captureView(DocumentState& document) {
        const auto iterator = editors.find(document.uri);
        if (iterator == editors.end()) return;
        auto& editor = *iterator->second;
        const auto selection = editor.GetMainCursorSelection();
        const auto cursor = editor.GetMainCursorPosition();
        document.view.cursor = {cursor.line, cursor.index, selection.start.line, selection.start.index};
        document.view.firstVisibleLine =
            editor.VisPos2DocPos({editor.GetFirstVisibleRow(), 0}).line;
        document.view.wordWrap = editor.IsWordWrapEnabled();
        document.view.miniMap = editor.IsShowMiniMapEnabled();
    }

    void restoreView(DocumentState& document, TextEditor& editor) {
        editor.SetWordWrapEnabled(document.view.wordWrap);
        editor.SetShowMiniMapEnabled(document.view.miniMap);
        const auto& cursor = document.view.cursor;
        if (cursor.anchorLine != cursor.line || cursor.anchorGlyph != cursor.glyph) {
            editor.SelectRegion({cursor.anchorLine, cursor.anchorGlyph}, {cursor.line, cursor.glyph});
        } else {
            editor.SetCursor({cursor.line, cursor.glyph});
        }
        editor.ScrollToLine(document.view.firstVisibleLine, TextEditor::Scroll::alignTop);
    }

    void applyDecorations(DocumentState& document, TextEditor& editor) {
        editor.ClearMarkers();
        editor.ClearSquiggles();
        for (const auto& diagnostic : document.diagnostics) {
            if (diagnostic.uri != document.uri) continue;
            const auto color = diagnosticColor(diagnostic.severity);
            const auto firstLine = std::min(diagnostic.range.start.line, editor.GetLineCount() - 1);
            const auto lastLine = std::min(diagnostic.range.end.line, editor.GetLineCount() - 1);
            for (std::size_t line = firstLine; line <= lastLine; ++line) {
                const auto text = editor.GetLineText(line);
                const auto start = line == diagnostic.range.start.line
                    ? EditorPanel::utf16ColumnToGlyph(text, diagnostic.range.start.column) : 0;
                const auto end = line == diagnostic.range.end.line
                    ? EditorPanel::utf16ColumnToGlyph(text, diagnostic.range.end.column)
                    : EditorPanel::utf16ColumnToGlyph(text, static_cast<std::size_t>(-1));
                if (end > start) editor.AddSquiggle({line, start}, {line, end},
                                                    static_cast<std::size_t>(diagnostic.severity), color,
                                                    diagnostic.message);
                editor.AddMarker(line, color, 0, diagnostic.message, {});
            }
        }
        if (document.flash.active) {
            float opacity = std::clamp(document.flash.remainingSeconds / anim::kSlow, 0.0F, 1.0F);
            if (ImGui::GetCurrentContext() != nullptr) {
                const double startedAt = ImGui::GetTime() -
                    static_cast<double>(anim::kSlow - document.flash.remainingSeconds);
                opacity = 1.0F - anim::stagger(startedAt, 0, anim::kSlow);
            }
            auto flash = ui::palette().editorLineHighlight;
            flash.w *= opacity;
            for (std::size_t line = document.flash.region.first;
                 line <= document.flash.region.last && line < editor.GetLineCount(); ++line) {
                editor.AddMarker(line, 0, ui::toU32(flash), {}, {});
            }
        }
    }

    TextEditor& ensureEditor(DocumentState& document) {
        auto& slot = editors[document.uri];
        if (!slot) {
            slot = std::make_unique<TextEditor>();
            slot->SetText(document.text);
            slot->SetLanguage(languageFor(document.language));
            slot->SetShowLineNumbersEnabled(true);
            slot->SetShowMatchingBrackets(true);
            slot->SetCompletePairedGlyphs(true);
            slot->SetAutoIndentEnabled(true);
            slot->SetChangeCallback([this, uri = document.uri] {
                auto* state = find(uri);
                const auto iterator = editors.find(uri);
                if (!state || iterator == editors.end()) return;
                const auto changed = iterator->second->GetText();
                if (changed == state->text) return;
                state->text = changed;
                state->dirty = state->text != state->baseText;
                if (!state->conflict) state->status = DocumentStatus::Ready;
                ++state->editRevision;
                captureView(*state);
            });
            TextEditor::AutoCompleteConfig completion;
            completion.callback = [this, uri = document.uri](TextEditor::AutoCompleteState& state) {
                auto* doc = find(uri);
                if (!doc || !requests.lsp) return;
                state.suggestionsPromise = true;
                active = uri;
                requestLsp(LspFeature::Completion, std::nullopt, state.searchTerm);
            };
            // The vendor copies this configuration in setConfig.
            slot->SetAutoCompleteConfig(&completion);
            restoreView(document, *slot);
        }
        slot->SetPalette(vendorPalette());
        applyDecorations(document, *slot);
        return *slot;
    }

    void setSnapshot(Snapshot snapshot, bool preserveView, ChangeOrigin origin, bool keepLocal = false) {
        auto iterator = documents.find(snapshot.uri);
        if (iterator == documents.end()) {
            tabs.push_back(snapshot.uri);
            iterator = documents.emplace(snapshot.uri, DocumentState{}).first;
        }
        auto& document = iterator->second;
        if (active.empty()) {
            active = iterator->first;
            requestedTab = active;
        }
        const auto oldText = document.text;
        if (preserveView) captureView(document);
        document.id = std::move(snapshot.id);
        document.uri = std::move(snapshot.uri);
        document.language = std::move(snapshot.language);
        document.stamp = std::move(snapshot.stamp);
        document.baseText = snapshot.text;
        if (!keepLocal) document.text = std::move(snapshot.text);
        document.dirty = document.text != document.baseText;
        document.conflict = false;
        document.error.clear();
        document.status = DocumentStatus::Ready;
        document.fallback = EditorPanel::fallbackFor(document.text);
        if (!keepLocal) ++document.editRevision;

        if (origin == ChangeOrigin::Agent && oldText != document.text) {
            document.flash = {EditorPanel::changedLines(oldText, document.text), anim::kSlow, true};
            anim::requestFrames();
        }

        const auto editor = editors.find(document.uri);
        if (editor != editors.end()) {
            if (document.fallback == FallbackMode::None) {
                editor->second->SetText(document.text);
                editor->second->SetLanguage(languageFor(document.language));
                restoreView(document, *editor->second);
                applyDecorations(document, *editor->second);
            } else {
                editors.erase(editor);
            }
        }
    }

    void requestRead(std::string uri, ChangeOrigin origin, bool preserveView, bool keepLocal) {
        if (!requests.read) {
            if (auto* document = find(uri)) {
                document->status = DocumentStatus::Error;
                document->error = "workspace.read is unavailable";
            }
            return;
        }
        const auto weak = std::weak_ptr<CallbackQueue>(callbackQueue);
        requests.read(workspace, uri, [weak, uri, origin, preserveView, keepLocal](Result<Snapshot> result) mutable {
            enqueueWeak(weak, [uri, result = std::move(result), origin, preserveView, keepLocal](Impl& self) mutable {
                if (auto* snapshot = std::get_if<Snapshot>(&result)) {
                    self.setSnapshot(std::move(*snapshot), preserveView, origin, keepLocal);
                } else if (const auto* error = std::get_if<RequestError>(&result)) {
                    auto* document = self.find(uri);
                    if (document) {
                        document->status = DocumentStatus::Error;
                        document->error = error->message;
                    }
                }
            });
        });
    }

    Position currentLspPosition() {
        auto* document = find(active);
        if (!document) return {};
        captureView(*document);
        const auto line = lineAt(document->text, document->view.cursor.line);
        return {document->view.cursor.line,
                EditorPanel::glyphToUtf16Column(line, document->view.cursor.glyph)};
    }

    void requestLsp(LspFeature feature, std::optional<Range> range = std::nullopt, std::string query = {}) {
        auto* document = find(active);
        if (!document || !requests.lsp) return;
        LspRequest request;
        request.feature = feature;
        request.workspaceId = workspace;
        request.uri = document->uri;
        request.position = currentLspPosition();
        request.range = std::move(range);
        request.diagnostics = document->diagnostics;
        request.query = std::move(query);
        const auto weak = std::weak_ptr<CallbackQueue>(callbackQueue);
        requests.lsp(std::move(request), [weak, feature](Result<LspValue> result) mutable {
            enqueueWeak(weak, [feature, result = std::move(result)](Impl& self) mutable {
                if (feature == LspFeature::Completion) {
                    if (auto* value = std::get_if<LspValue>(&result)) {
                        if (auto* items = std::get_if<std::vector<CompletionItem>>(value)) {
                            std::vector<std::string> suggestions;
                            suggestions.reserve(items->size());
                            for (const auto& item : *items) suggestions.push_back(item.insertText.empty() ? item.label : item.insertText);
                            const auto editor = self.editors.find(self.active);
                            if (editor != self.editors.end()) editor->second->SetAutoCompleteSuggestions(suggestions);
                        }
                    }
                }
                if (self.lspHandler) self.lspHandler(feature, std::move(result));
            });
        });
    }
};

EditorPanel::EditorPanel(EditorRequests requests) : impl_(std::make_unique<Impl>(std::move(requests))) {}
EditorPanel::~EditorPanel() = default;
EditorPanel::EditorPanel(EditorPanel&&) noexcept = default;
EditorPanel& EditorPanel::operator=(EditorPanel&&) noexcept = default;

void EditorPanel::setWorkspace(std::string workspaceId) {
    assert(std::this_thread::get_id() == impl_->owner);
    if (impl_->workspace == workspaceId) return;
    impl_->workspace = std::move(workspaceId);
    impl_->documents.clear();
    impl_->editors.clear();
    impl_->tabs.clear();
    impl_->active.clear();
}

const std::string& EditorPanel::workspace() const noexcept { return impl_->workspace; }

void EditorPanel::open(std::string uri) {
    assert(std::this_thread::get_id() == impl_->owner);
    if (impl_->documents.contains(uri)) {
        impl_->active = uri;
        impl_->requestedTab = std::move(uri);
        return;
    }
    DocumentState loading;
    loading.uri = uri;
    loading.status = DocumentStatus::Loading;
    impl_->documents.emplace(uri, std::move(loading));
    impl_->tabs.push_back(uri);
    impl_->active = uri;
    impl_->requestedTab = uri;
    impl_->requestRead(std::move(uri), ChangeOrigin::External, false, false);
}

bool EditorPanel::close(std::string_view uri, bool discardDirty) {
    auto* document = impl_->find(uri);
    if (!document) return false;
    if (document->dirty && !discardDirty) return false;
    const std::string key(uri);
    impl_->documents.erase(key);
    impl_->editors.erase(key);
    const auto iterator = std::find(impl_->tabs.begin(), impl_->tabs.end(), key);
    if (iterator != impl_->tabs.end()) {
        const auto index = static_cast<std::size_t>(iterator - impl_->tabs.begin());
        impl_->tabs.erase(iterator);
        if (impl_->active == key) {
            impl_->active = impl_->tabs.empty() ? std::string{} : impl_->tabs[std::min(index, impl_->tabs.size() - 1)];
            impl_->requestedTab = impl_->active;
        }
    }
    return true;
}

bool EditorPanel::activate(std::string_view uri) {
    if (!impl_->find(uri)) return false;
    impl_->active = std::string(uri);
    impl_->requestedTab = impl_->active;
    return true;
}

std::string_view EditorPanel::activeUri() const noexcept { return impl_->active; }
const std::vector<std::string>& EditorPanel::tabs() const noexcept { return impl_->tabs; }
const DocumentState* EditorPanel::document(std::string_view uri) const noexcept { return impl_->find(uri); }
DocumentState* EditorPanel::document(std::string_view uri) noexcept { return impl_->find(uri); }

void EditorPanel::acceptSnapshot(Snapshot snapshot, bool preserveView, ChangeOrigin origin) {
    impl_->setSnapshot(std::move(snapshot), preserveView, origin);
}

void EditorPanel::replaceText(std::string_view uri, std::string text) {
    auto* document = impl_->find(uri);
    if (!document || document->fallback != FallbackMode::None || document->status == DocumentStatus::Loading) return;
    document->text = std::move(text);
    document->fallback = fallbackFor(document->text);
    document->dirty = document->text != document->baseText;
    if (!document->conflict) document->status = DocumentStatus::Ready;
    ++document->editRevision;
    const auto editor = impl_->editors.find(document->uri);
    if (editor != impl_->editors.end()) {
        if (document->fallback == FallbackMode::None) {
            impl_->captureView(*document);
            editor->second->SetText(document->text);
            impl_->restoreView(*document, *editor->second);
        } else {
            impl_->editors.erase(editor);
        }
    }
}

void EditorPanel::setView(std::string_view uri, ViewState view) {
    if (auto* document = impl_->find(uri)) document->view = view;
}

void EditorPanel::save(std::string_view uri) {
    const auto target = impl_->target(uri);
    auto* document = impl_->find(target);
    if (!document || !document->dirty || document->conflict ||
        document->fallback != FallbackMode::None ||
        document->status == DocumentStatus::Saving || !impl_->requests.write) return;
    const auto sentText = document->text;
    const auto expectedSha = document->stamp.sha256;
    const auto revision = document->editRevision;
    document->status = DocumentStatus::Saving;
    const auto weak = std::weak_ptr<Impl::CallbackQueue>(impl_->callbackQueue);
    impl_->requests.write(impl_->workspace, target, sentText, expectedSha,
        [weak, target, sentText, revision](Result<FileStamp> result) mutable {
            Impl::enqueueWeak(weak, [target, sentText, revision, result = std::move(result)](Impl& self) mutable {
                auto* state = self.find(target);
                if (!state) return;
                if (auto* stamp = std::get_if<FileStamp>(&result)) {
                    state->stamp = std::move(*stamp);
                    state->baseText = sentText;
                    state->dirty = state->text != state->baseText;
                    state->conflict = false;
                    state->status = DocumentStatus::Ready;
                    state->error.clear();
                    if (state->editRevision < revision) state->editRevision = revision;
                } else if (const auto* error = std::get_if<RequestError>(&result)) {
                    state->conflict = error->isConflict();
                    state->status = state->conflict ? DocumentStatus::Conflict : DocumentStatus::Error;
                    state->error = error->message;
                }
            });
        });
}

void EditorPanel::reloadDiscardingLocal(std::string_view uri) {
    const auto target = impl_->target(uri);
    if (auto* document = impl_->find(target)) document->status = DocumentStatus::Loading;
    impl_->requestRead(target, ChangeOrigin::External, true, false);
}

void EditorPanel::keepLocalAgainstLatest(std::string_view uri) {
    const auto target = impl_->target(uri);
    impl_->requestRead(target, ChangeOrigin::External, true, true);
}

void EditorPanel::fileChanged(std::string uri, ChangeOrigin origin, std::optional<FileStamp> stamp) {
    auto* document = impl_->find(uri);
    if (!document) return;
    if (stamp && stamp->sha256 == document->stamp.sha256) return;
    if (document->dirty || document->status == DocumentStatus::Saving) {
        document->conflict = true;
        document->status = DocumentStatus::Conflict;
        document->error = "File changed outside this editor";
        return;
    }
    document->status = DocumentStatus::Loading;
    impl_->requestRead(std::move(uri), origin, true, false);
}

void EditorPanel::setDiagnostics(std::string uri, std::vector<Diagnostic> diagnostics) {
    if (auto* document = impl_->find(uri)) {
        document->diagnostics = std::move(diagnostics);
        const auto editor = impl_->editors.find(document->uri);
        if (editor != impl_->editors.end()) impl_->applyDecorations(*document, *editor->second);
    }
}

void EditorPanel::requestDefinition() { impl_->requestLsp(LspFeature::Definition); }
void EditorPanel::requestReferences() { impl_->requestLsp(LspFeature::References); }
void EditorPanel::requestHover() { impl_->requestLsp(LspFeature::Hover); }
void EditorPanel::requestCompletion(std::string query) { impl_->requestLsp(LspFeature::Completion, std::nullopt, std::move(query)); }
void EditorPanel::requestCodeActions(std::optional<Range> range) { impl_->requestLsp(LspFeature::CodeAction, std::move(range)); }
void EditorPanel::setLspResultHandler(std::function<void(LspFeature, Result<LspValue>)> handler) { impl_->lspHandler = std::move(handler); }

void EditorPanel::processCallbacks() {
    assert(std::this_thread::get_id() == impl_->owner);
    std::deque<std::function<void(Impl&)>> callbacks;
    {
        std::lock_guard lock(impl_->callbackQueue->mutex);
        callbacks.swap(impl_->callbackQueue->callbacks);
    }
    for (auto& callback : callbacks) callback(*impl_);
}

void EditorPanel::advanceAnimations(float deltaSeconds) {
    if (deltaSeconds <= 0.0F) return;
    for (auto& [uri, document] : impl_->documents) {
        (void)uri;
        if (!document.flash.active) continue;
        document.flash.remainingSeconds = std::max(0.0F, document.flash.remainingSeconds - deltaSeconds);
        if (document.flash.remainingSeconds == 0.0F) document.flash.active = false;
    }
}

void EditorPanel::cut() {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->Cut();
}
void EditorPanel::copy() {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->Copy();
}
void EditorPanel::paste() {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->Paste();
}
void EditorPanel::selectAll() {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->SelectAll();
}
void EditorPanel::addNextOccurrence(bool wholeWord) {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->AddNextOccurrence(wholeWord);
}
void EditorPanel::selectAllOccurrences(bool wholeWord) {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->SelectAllOccurrences(wholeWord);
}

void EditorPanel::undo() {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->Undo();
}
void EditorPanel::redo() {
    const auto iterator = impl_->editors.find(impl_->active);
    if (iterator != impl_->editors.end()) iterator->second->Redo();
}
bool EditorPanel::canUndo() const {
    const auto iterator = impl_->editors.find(impl_->active);
    return iterator != impl_->editors.end() && iterator->second->CanUndo();
}
bool EditorPanel::canRedo() const {
    const auto iterator = impl_->editors.find(impl_->active);
    return iterator != impl_->editors.end() && iterator->second->CanRedo();
}

void EditorPanel::draw(const char* id, float width, float height) {
    assert(std::this_thread::get_id() == impl_->owner);
    processCallbacks();
    advanceAnimations(anim::dt());
    if (impl_->tabs.empty()) {
        ImGui::TextDisabled("No file open");
        return;
    }

    if (ImGui::BeginTabBar(id, ImGuiTabBarFlags_Reorderable | ImGuiTabBarFlags_AutoSelectNewTabs)) {
        std::optional<std::string> closeUri;
        for (const auto& uri : impl_->tabs) {
            auto* document = impl_->find(uri);
            if (!document) continue;
            bool openTab = true;
            const auto label = tabLabel(*document);
            ImGuiTabItemFlags flags = uri == impl_->requestedTab ? ImGuiTabItemFlags_SetSelected
                                                                 : ImGuiTabItemFlags_None;
            if (document->dirty) flags |= ImGuiTabItemFlags_UnsavedDocument;
            if (ImGui::BeginTabItem(label.c_str(), &openTab, flags)) {
                impl_->active = uri;
                ImGui::EndTabItem();
            }
            if (!openTab && !document->dirty) closeUri = uri;
        }
        ImGui::EndTabBar();
        impl_->requestedTab.clear();
        if (closeUri) (void)close(*closeUri, true);
    }

    auto* document = impl_->find(impl_->active);
    if (!document) return;
    if (document->status == DocumentStatus::Loading) {
        ImGui::TextDisabled("Loading file...");
        return;
    }
    if (document->status == DocumentStatus::Error) {
        ImGui::TextUnformatted(document->error.c_str());
        return;
    }
    if (document->status == DocumentStatus::Conflict) {
        ImGui::TextUnformatted("File changed on disk. Reload or keep local changes before saving.");
    }

    if (document->fallback != FallbackMode::None) {
        const char* reason = document->fallback == FallbackMode::Binary ? "Binary file (editing unavailable)" :
                             document->fallback == FallbackMode::Oversized ? "File is too large for native editing" :
                             "File contains a line too long for native editing";
        ImGui::TextDisabled("%s", reason);
        ImGui::Separator();
        if (document->fallback != FallbackMode::Binary) {
            auto previewSize = std::min(document->text.size(), kFallbackPreviewBytes);
            while (previewSize > 0 && previewSize < document->text.size() &&
                   (static_cast<unsigned char>(document->text[previewSize]) & 0xC0U) == 0x80U) --previewSize;
            ImGui::BeginChild("fallback-preview", ImVec2(width, height), ImGuiChildFlags_None,
                              ImGuiWindowFlags_HorizontalScrollbar);
            ImGui::TextUnformatted(document->text.data(), document->text.data() + previewSize);
            ImGui::EndChild();
        }
        return;
    }

    auto& editor = impl_->ensureEditor(*document);
    if (editor.Render("native-text-editor", ImVec2(width, height))) {
        document->text = editor.GetText();
        document->dirty = document->text != document->baseText;
        if (!document->conflict) document->status = DocumentStatus::Ready;
        ++document->editRevision;
    }
    impl_->captureView(*document);
    if (document->flash.active) anim::requestFrames();
}

FallbackMode EditorPanel::fallbackFor(std::string_view text) noexcept {
    if (text.size() > kMaximumEditableBytes) return FallbackMode::Oversized;
    std::size_t lineBytes = 0;
    for (std::size_t offset = 0; offset < text.size();) {
        if (text[offset] == '\0') return FallbackMode::Binary;
        if (text[offset] == '\n') {
            lineBytes = 0;
            ++offset;
            continue;
        }
        const auto codepoint = decodeUtf8(text, offset);
        if (!codepoint.valid) return FallbackMode::Binary;
        lineBytes += codepoint.bytes;
        if (lineBytes > kMaximumEditableLineBytes) return FallbackMode::LongLine;
        offset += codepoint.bytes;
    }
    return FallbackMode::None;
}

LineRegion EditorPanel::changedLines(std::string_view before, std::string_view after) noexcept {
    if (before == after) return {};
    const auto countLines = [](std::string_view text) {
        return std::size_t{1} + static_cast<std::size_t>(std::count(text.begin(), text.end(), '\n'));
    };
    const auto oldTotal = countLines(before);
    const auto newTotal = countLines(after);

    std::size_t prefix = 0;
    std::size_t oldOffset = 0;
    std::size_t newOffset = 0;
    while (oldOffset <= before.size() && newOffset <= after.size()) {
        const auto oldEnd = before.find('\n', oldOffset);
        const auto newEnd = after.find('\n', newOffset);
        const auto oldLine = before.substr(oldOffset, oldEnd == std::string_view::npos
                                                        ? before.size() - oldOffset : oldEnd - oldOffset);
        const auto newLine = after.substr(newOffset, newEnd == std::string_view::npos
                                                       ? after.size() - newOffset : newEnd - newOffset);
        if (oldLine != newLine) break;
        ++prefix;
        if (oldEnd == std::string_view::npos || newEnd == std::string_view::npos) break;
        oldOffset = oldEnd + 1;
        newOffset = newEnd + 1;
    }

    std::size_t suffix = 0;
    std::size_t oldEnd = before.size();
    std::size_t newEnd = after.size();
    while (suffix + prefix < oldTotal && suffix + prefix < newTotal) {
        const auto oldSeparator = oldEnd == 0 ? std::string_view::npos : before.rfind('\n', oldEnd - 1);
        const auto newSeparator = newEnd == 0 ? std::string_view::npos : after.rfind('\n', newEnd - 1);
        const auto oldStart = oldSeparator == std::string_view::npos ? 0 : oldSeparator + 1;
        const auto newStart = newSeparator == std::string_view::npos ? 0 : newSeparator + 1;
        if (before.substr(oldStart, oldEnd - oldStart) != after.substr(newStart, newEnd - newStart)) break;
        ++suffix;
        oldEnd = oldSeparator == std::string_view::npos ? 0 : oldSeparator;
        newEnd = newSeparator == std::string_view::npos ? 0 : newSeparator;
    }
    const auto oldChanged = oldTotal - prefix - suffix;
    const auto newChanged = newTotal - prefix - suffix;
    const auto changedCount = std::max<std::size_t>(1, std::max(oldChanged, newChanged));
    return {prefix, prefix + changedCount - 1};
}

std::size_t EditorPanel::utf16ColumnToGlyph(std::string_view utf8Line, std::size_t utf16Column) noexcept {
    std::size_t offset = 0;
    std::size_t glyph = 0;
    std::size_t units = 0;
    while (offset < utf8Line.size()) {
        const auto codepoint = decodeUtf8(utf8Line, offset);
        if (!codepoint.valid) break;
        const std::size_t width = codepoint.value > 0xFFFFU ? 2 : 1;
        if (units + width > utf16Column) break;
        units += width;
        offset += codepoint.bytes;
        ++glyph;
        if (units == utf16Column) break;
    }
    return glyph;
}

std::size_t EditorPanel::glyphToUtf16Column(std::string_view utf8Line, std::size_t glyphColumn) noexcept {
    std::size_t offset = 0;
    std::size_t glyph = 0;
    std::size_t units = 0;
    while (offset < utf8Line.size() && glyph < glyphColumn) {
        const auto codepoint = decodeUtf8(utf8Line, offset);
        if (!codepoint.valid) break;
        units += codepoint.value > 0xFFFFU ? 2 : 1;
        offset += codepoint.bytes;
        ++glyph;
    }
    return units;
}

#if CHUD_EDITOR_HAS_DESKTOP_CLIENT
EditorRequests EditorRequests::forProtocolClient(DesktopClient& client) {
    EditorRequests requests;
    requests.read = [&client](std::string workspaceId, std::string uri, ReadCallback callback) {
        client.request("workspace.read", Json{{"workspaceId", std::move(workspaceId)}, {"uri", std::move(uri)}},
            [callback = std::move(callback)](const ResponseFrame& response) mutable {
                if (response.error || !response.result || !response.result->contains("document")) {
                    callback(responseError(response));
                    return;
                }
                const auto& value = response.result->at("document");
                if (!value.is_object() || !value.contains("stamp")) {
                    callback(RequestError{"invalid-response", "workspace.read omitted its document stamp"});
                    return;
                }
                Snapshot snapshot;
                snapshot.id = value.value("id", std::string{});
                snapshot.uri = value.value("uri", std::string{});
                snapshot.language = value.value("language", std::string{});
                snapshot.text = value.value("text", std::string{});
                snapshot.stamp = parseStamp(value["stamp"]);
                callback(std::move(snapshot));
            });
    };
    requests.write = [&client](std::string workspaceId, std::string uri, std::string text,
                               std::string expectedSha256, WriteCallback callback) {
        client.request("workspace.write",
            Json{{"workspaceId", std::move(workspaceId)}, {"uri", std::move(uri)},
                 {"text", std::move(text)}, {"expectedSha256", std::move(expectedSha256)}},
            [callback = std::move(callback)](const ResponseFrame& response) mutable {
                if (response.error || !response.result || !response.result->contains("stamp")) {
                    callback(responseError(response));
                    return;
                }
                callback(parseStamp(response.result->at("stamp")));
            });
    };
    requests.lsp = [&client](LspRequest request, LspCallback callback) {
        Json params{{"workspaceId", std::move(request.workspaceId)},
                    {"method", lspMethod(request.feature)},
                    {"uri", std::move(request.uri)},
                    {"position", Json{{"line", request.position.line}, {"column", request.position.column}}}};
        if (!request.query.empty()) params["query"] = std::move(request.query);
        if (request.range) {
            params["range"] = Json{{"start", Json{{"line", request.range->start.line},
                                                   {"column", request.range->start.column}}},
                                   {"end", Json{{"line", request.range->end.line},
                                                 {"column", request.range->end.column}}}};
        }
        if (request.feature == LspFeature::References) params["includeDeclaration"] = request.includeDeclaration;
        if (request.feature == LspFeature::CodeAction) {
            Json diagnostics = Json::array();
            for (const auto& diagnostic : request.diagnostics) {
                diagnostics.push_back(Json{{"uri", diagnostic.uri},
                                           {"severity", static_cast<unsigned>(diagnostic.severity)},
                                           {"message", diagnostic.message},
                                           {"source", diagnostic.source},
                                           {"startLine", diagnostic.range.start.line},
                                           {"startColumn", diagnostic.range.start.column},
                                           {"endLine", diagnostic.range.end.line},
                                           {"endColumn", diagnostic.range.end.column}});
            }
            params["context"] = Json{{"diagnostics", std::move(diagnostics)}};
        }
        const auto feature = request.feature;
        client.request("lsp.request", std::move(params),
            [feature, callback = std::move(callback)](const ResponseFrame& response) mutable {
                if (response.error || !response.result || !response.result->contains("value")) {
                    callback(responseError(response));
                    return;
                }
                callback(parseLspValue(feature, response.result->at("value")));
            });
    };
    return requests;
}
#else
EditorRequests EditorRequests::forProtocolClient(DesktopClient&) { return {}; }
#endif

} // namespace chud::editor
