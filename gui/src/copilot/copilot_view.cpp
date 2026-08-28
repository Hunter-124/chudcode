#include "copilot/copilot_view.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <initializer_list>
#include <string>
#include <utility>

#include "theme/theme.h"
#include "widgets/kit.h"

namespace chud::copilot {
namespace {

std::string jsonText(const Json& value) {
    if (value.is_string()) return value.get<std::string>();
    if (!value.is_array()) return {};

    std::string text;
    for (const auto& block : value) {
        if (!block.is_object()) continue;
        const std::string type = block.value("type", "");
        if (type == "text") {
            text += block.value("text", "");
        } else if (type == "image") {
            if (!text.empty()) text += '\n';
            text += "[image]";
        }
    }
    return text;
}

std::string firstString(const Json& value,
                        std::initializer_list<std::string_view> keys) {
    if (!value.is_object()) return {};
    for (const std::string_view key : keys) {
        const auto it = value.find(std::string(key));
        if (it != value.end() && it->is_string()) return it->get<std::string>();
    }
    return {};
}

std::string readableName(std::string value) {
    bool capitalize = true;
    for (char& ch : value) {
        if (ch == '_' || ch == '.' || ch == '-') {
            ch = ' ';
            capitalize = true;
        } else if (capitalize && ch >= 'a' && ch <= 'z') {
            ch = static_cast<char>(ch - 'a' + 'A');
            capitalize = false;
        } else {
            capitalize = false;
        }
    }
    return value;
}

kit::Tone toneFor(const TranscriptRow& row) {
    if (row.failed) return kit::Tone::Err;
    switch (row.kind) {
    case TranscriptKind::Assistant: return kit::Tone::Accent;
    case TranscriptKind::User: return kit::Tone::Info;
    case TranscriptKind::Tool: return row.live ? kit::Tone::Warn : kit::Tone::Neutral;
    case TranscriptKind::ToolResult: return kit::Tone::Ok;
    case TranscriptKind::Agent: return row.live ? kit::Tone::Accent : kit::Tone::Neutral;
    case TranscriptKind::Task: return kit::Tone::Info;
    case TranscriptKind::UiRequest: return kit::Tone::Warn;
    case TranscriptKind::Thinking:
    case TranscriptKind::Status:
    case TranscriptKind::System: return kit::Tone::Neutral;
    }
    return kit::Tone::Neutral;
}

const char* statusLabel(std::string_view state) {
    if (state.empty()) return "todo";
    return state.data();
}

struct ComposerCallbackContext {
    CopilotView* view = nullptr;
    ComposerDraft* draft = nullptr;
    std::string* buffer = nullptr;
};

struct StringInputContext {
    std::string* value = nullptr;
};

int stringInputCallback(ImGuiInputTextCallbackData* data) {
    auto* context = static_cast<StringInputContext*>(data->UserData);
    if (data->EventFlag != ImGuiInputTextFlags_CallbackResize) return 0;
    context->value->resize(static_cast<std::size_t>(data->BufTextLen));
    data->Buf = context->value->data();
    return 0;
}

bool inputTextString(const char* id, std::string& value) {
    value.reserve(std::max<std::size_t>(value.capacity(), 256));
    StringInputContext context{&value};
    const bool changed = ImGui::InputText(id, value.data(), value.capacity() + 1,
                                          ImGuiInputTextFlags_CallbackResize,
                                          stringInputCallback, &context);
    value.resize(std::strlen(value.c_str()));
    return changed;
}

bool containsWord(std::string_view haystack, std::string_view needle) {
    return haystack.find(needle) != std::string_view::npos;
}

void appendTask(const Json& payload, std::string fallbackId,
                std::vector<TaskItem>& tasks) {
    if (!payload.is_object()) return;
    TaskItem task;
    task.id = firstString(payload, {"id", "taskId", "todoId"});
    if (task.id.empty()) task.id = std::move(fallbackId);
    task.title = firstString(payload, {"title", "desc", "description", "text"});
    if (task.title.empty() && payload.contains("content")) task.title = jsonText(payload["content"]);
    task.state = firstString(payload, {"state", "status"});
    if (task.state.empty()) task.state = "todo";
    if (const auto parent = firstString(payload, {"parentId", "parent_id"}); !parent.empty())
        task.parentId = parent;
    task.phase = firstString(payload, {"phase"});
    if (!task.title.empty()) tasks.push_back(std::move(task));
}

void appendTaskArrays(const Json& payload, std::string_view fallbackPrefix,
                      std::vector<TaskItem>& tasks) {
    if (!payload.is_object()) return;
    for (const char* key : {"tasks", "todos"}) {
        const auto values = payload.find(key);
        if (values == payload.end() || !values->is_array()) continue;
        std::size_t index = 0;
        for (const auto& value : *values) {
            appendTask(value,
                       std::string(fallbackPrefix) + ":" + key + ":" +
                           std::to_string(index++),
                       tasks);
        }
    }
}

}  // namespace

TranscriptProjection TranscriptProjection::from(const SessionSnapshot& snapshot) {
    TranscriptProjection result;
    std::size_t order = 0;
    std::vector<ActiveTool> active;

    auto removeActiveTool = [&](std::string_view id) {
        active.erase(std::remove_if(active.begin(), active.end(),
                                    [&](const ActiveTool& tool) { return tool.id == id; }),
                     active.end());
    };
    auto append = [&](TranscriptRow row) {
        row.order = order++;
        result.rows.push_back(std::move(row));
    };

    for (const SessionEntry& entry : snapshot.entries) {
        const Json& payload = entry.payload;
        if (entry.kind == SessionEntryKind::Message && payload.contains("message") &&
            payload["message"].is_object()) {
            const Json& message = payload["message"];
            const std::string role = message.value("role", "message");
            if (role == "assistant" && message.contains("content") &&
                message["content"].is_array()) {
                std::size_t blockIndex = 0;
                for (const auto& block : message["content"]) {
                    if (!block.is_object()) {
                        ++blockIndex;
                        continue;
                    }
                    const std::string type = block.value("type", "");
                    TranscriptRow row;
                    row.id = entry.id + ":" + std::to_string(blockIndex++);
                    row.detail = block;
                    row.meta = message.value("model", "");
                    if (type == "text") {
                        row.kind = TranscriptKind::Assistant;
                        row.title = "Assistant";
                        row.text = block.value("text", "");
                    } else if (type == "thinking") {
                        row.kind = TranscriptKind::Thinking;
                        row.title = "Thinking";
                        row.text = block.value("thinking", "");
                    } else if (type == "redactedThinking") {
                        row.kind = TranscriptKind::Thinking;
                        row.title = "Redacted thinking";
                        row.text = "Content hidden by provider";
                    } else if (type == "toolCall") {
                        row.kind = TranscriptKind::Tool;
                        row.title = block.value("name", "Tool");
                        row.text = block.value("intent", "");
                        ActiveTool tool{block.value("id", row.id), block.value("name", "Tool"),
                                        block.value("intent", ""),
                                        block.value("arguments", Json::object())};
                        removeActiveTool(tool.id);
                        active.push_back(std::move(tool));
                    } else {
                        row.kind = TranscriptKind::System;
                        row.title = readableName(type.empty() ? "assistant content" : type);
                        row.text = block.dump();
                    }
                    append(std::move(row));
                }
            } else {
                TranscriptRow row;
                row.id = entry.id;
                row.detail = message;
                row.meta = entry.timestamp;
                if (role == "user") {
                    row.kind = TranscriptKind::User;
                    row.title = "You";
                } else if (role == "toolResult") {
                    row.kind = TranscriptKind::ToolResult;
                    row.title = message.value("toolName", "Tool result");
                    row.failed = message.value("isError", false);
                    removeActiveTool(message.value("toolCallId", ""));
                } else {
                    row.kind = TranscriptKind::System;
                    row.title = readableName(role);
                }
                if (message.contains("content")) row.text = jsonText(message["content"]);
                append(std::move(row));
            }
            continue;
        }

        TranscriptRow row;
        row.id = entry.id;
        row.detail = payload;
        row.meta = entry.timestamp;
        switch (entry.kind) {
        case SessionEntryKind::CustomMessage: {
            const std::string customType = payload.value("customType", "custom message");
            const bool display = payload.value("display", true);
            if (!display) continue;
            row.kind = containsWord(customType, "task") || containsWord(customType, "todo")
                           ? TranscriptKind::Task
                           : containsWord(customType, "agent") ? TranscriptKind::Agent
                                                                : TranscriptKind::System;
            row.title = readableName(customType);
            if (payload.contains("content")) row.text = jsonText(payload["content"]);
            if (row.kind == TranscriptKind::Task) {
                appendTask(payload, entry.id, result.tasks);
                appendTaskArrays(payload, entry.id, result.tasks);
            }
            break;
        }
        case SessionEntryKind::Compaction:
            row.kind = TranscriptKind::Status;
            row.title = "Context compacted";
            row.text = payload.value("summary", "");
            break;
        case SessionEntryKind::BranchSummary:
            row.kind = TranscriptKind::Status;
            row.title = "Branch summary";
            row.text = payload.value("summary", "");
            break;
        case SessionEntryKind::ModelChange:
            row.kind = TranscriptKind::Status;
            row.title = "Model changed";
            row.text = payload.value("model", "");
            break;
        case SessionEntryKind::ThinkingLevelChange:
            row.kind = TranscriptKind::Status;
            row.title = "Thinking level changed";
            row.text = payload.value("thinkingLevel", "");
            break;
        case SessionEntryKind::Unknown:
            row.kind = TranscriptKind::System;
            row.title = "Session event";
            row.text = payload.dump();
            break;
        case SessionEntryKind::Message:
            continue;
        }
        append(std::move(row));
    }

    if (snapshot.latestAgentEvent) {
        const AgentEvent& event = *snapshot.latestAgentEvent;
        TranscriptRow row;
        row.id = "live-agent:" + event.type;
        row.title = readableName(event.type);
        row.text = firstString(event.payload, {"text", "message", "delta", "intent", "status"});
        row.detail = event.payload;
        row.live = true;
        row.failed = containsWord(event.type, "error") ||
                     (event.payload.is_object() && event.payload.value("isError", false));
        if (containsWord(event.type, "tool")) {
            row.kind = TranscriptKind::Tool;
            const std::string toolId = firstString(event.payload, {"id", "toolCallId", "callId"});
            if (containsWord(event.type, "end") || containsWord(event.type, "result") ||
                containsWord(event.type, "complete")) {
                removeActiveTool(toolId);
                row.live = false;
            } else if (!toolId.empty()) {
                const Json arguments =
                    event.payload.is_object() ? event.payload.value("arguments", Json::object())
                                              : Json::object();
                ActiveTool tool{toolId,
                                firstString(event.payload, {"name", "toolName"}),
                                firstString(event.payload, {"intent", "text"}),
                                arguments};
                removeActiveTool(tool.id);
                active.push_back(std::move(tool));
            }
        } else if (containsWord(event.type, "thinking")) {
            row.kind = TranscriptKind::Thinking;
        } else if (containsWord(event.type, "assistant") ||
                   containsWord(event.type, "message_delta") ||
                   containsWord(event.type, "text_delta")) {
            row.kind = TranscriptKind::Assistant;
            row.title = "Assistant";
        } else {
            row.kind = TranscriptKind::Agent;
        }
        append(std::move(row));

        if (containsWord(event.type, "task") || containsWord(event.type, "todo"))
            appendTask(event.payload, "live-task", result.tasks);
        appendTaskArrays(event.payload, "live-task", result.tasks);
    }

    if (snapshot.state && snapshot.state->isStreaming) {
        TranscriptRow row;
        row.id = "live-stream";
        row.kind = TranscriptKind::Status;
        row.title = snapshot.state->isAborting.value_or(false) ? "Stopping" : "Assistant is working";
        row.text = snapshot.state->queuedMessageCount > 0
                       ? std::to_string(snapshot.state->queuedMessageCount) + " queued"
                       : std::string{};
        row.live = true;
        append(std::move(row));
    }

    if (snapshot.uiRequest) {
        TranscriptRow row;
        row.id = "ui-request:" + std::to_string(snapshot.uiRequest->reqId);
        row.kind = TranscriptKind::UiRequest;
        row.title = snapshot.uiRequest->title;
        row.text = firstString(snapshot.uiRequest->payload,
                               {"message", "prompt", "question", "description"});
        row.detail = snapshot.uiRequest->payload;
        row.live = true;
        append(std::move(row));
        result.uiRequest = snapshot.uiRequest;
    }

    result.activeTools = std::move(active);
    return result;
}

SoftWrappedText::SoftWrappedText(std::string text, std::size_t wrapColumns)
    : wrapColumns_(wrapColumns) {
    setCanonical(std::move(text));
}

void SoftWrappedText::rememberSnapshot() {
    if (breakHistory_.empty() || breakHistory_.back().display != displayText_ ||
        breakHistory_.back().hardBreaks != hardBreakOffsets_) {
        breakHistory_.push_back({displayText_, hardBreakOffsets_});
        constexpr std::size_t kMaximumBreakHistory = 64;
        if (breakHistory_.size() > kMaximumBreakHistory) breakHistory_.erase(breakHistory_.begin());
    }
}

void SoftWrappedText::reseedBreaks(std::string_view display) {
    hardBreakOffsets_.clear();
    for (std::size_t offset = 0; offset < display.size(); ++offset) {
        if (display[offset] == '\n') hardBreakOffsets_.push_back(offset);
    }
    editLength_ = display.size();
}

void SoftWrappedText::setCanonical(std::string text) {
    breakHistory_.clear();
    reseedBreaks(text);
    editPending_ = false;
    rewrap(std::move(text));
}

void SoftWrappedText::setWrapColumns(std::size_t columns) {
    if (columns == wrapColumns_) return;
    const std::string canonical = canonicalText();
    wrapColumns_ = columns;
    breakHistory_.clear();
    editLength_ = canonical.size();
    editPending_ = false;
    rewrap(canonical);
}

bool SoftWrappedText::isHardBreak(std::size_t offset) const noexcept {
    return std::binary_search(hardBreakOffsets_.begin(), hardBreakOffsets_.end(), offset);
}

std::string SoftWrappedText::canonicalText() const {
    std::string result = displayText_;
    for (const std::size_t offset : softBreakOffsets_) {
        if (offset < result.size() && result[offset] == '\n') result[offset] = ' ';
    }
    return result;
}

std::string SoftWrappedText::copyRange(std::size_t first, std::size_t last) const {
    first = std::min(first, displayText_.size());
    last = std::min(last, displayText_.size());
    if (last < first) std::swap(first, last);
    std::string result = displayText_.substr(first, last - first);
    for (std::size_t index = 0; index < result.size(); ++index) {
        const std::size_t source = first + index;
        if (result[index] == '\n' && !isHardBreak(source)) result[index] = ' ';
    }
    return result;
}

void SoftWrappedText::recordEdit(std::string_view editedDisplay, std::size_t cursor) {
    rememberSnapshot();
    cursor = std::min(cursor, editedDisplay.size());
    editPending_ = true;

    if (editedDisplay.size() == editLength_) return;

    if (editedDisplay.size() > editLength_) {
        const std::size_t inserted = editedDisplay.size() - editLength_;
        const std::size_t editStart = cursor >= inserted ? cursor - inserted : 0;
        for (std::size_t& offset : hardBreakOffsets_) {
            if (offset >= editStart) offset += inserted;
        }
        for (std::size_t offset = editStart; offset < cursor; ++offset) {
            if (editedDisplay[offset] == '\n') hardBreakOffsets_.push_back(offset);
        }
    } else {
        const std::size_t removed = editLength_ - editedDisplay.size();
        const std::size_t editStart = std::min(cursor, editLength_);
        const std::size_t editEnd =
            editStart + std::min(removed, editLength_ - editStart);
        std::vector<std::size_t> shifted;
        shifted.reserve(hardBreakOffsets_.size());
        for (const std::size_t offset : hardBreakOffsets_) {
            if (offset < editStart) {
                shifted.push_back(offset);
            } else if (offset >= editEnd) {
                shifted.push_back(offset - removed);
            }
        }
        hardBreakOffsets_ = std::move(shifted);
    }

    std::sort(hardBreakOffsets_.begin(), hardBreakOffsets_.end());
    hardBreakOffsets_.erase(
        std::unique(hardBreakOffsets_.begin(), hardBreakOffsets_.end()),
        hardBreakOffsets_.end());
    editLength_ = editedDisplay.size();
}

void SoftWrappedText::applyEdited(std::string editedDisplay) {
    if (!editPending_) rememberSnapshot();

    if (!editPending_ && editedDisplay.size() != editLength_) {
        // No edit callback preceded this length change, so the whole value came
        // from outside the active widget and each newline is authored.
        reseedBreaks(editedDisplay);
    } else if (editPending_) {
        const auto historical = std::find_if(
            breakHistory_.rbegin(), breakHistory_.rend(),
            [&](const BreakSnapshot& snapshot) { return snapshot.display == editedDisplay; });
        if (historical != breakHistory_.rend()) {
            hardBreakOffsets_ = historical->hardBreaks;
            editLength_ = editedDisplay.size();
        }
    }

    hardBreakOffsets_.erase(
        std::remove_if(hardBreakOffsets_.begin(), hardBreakOffsets_.end(),
                       [&](std::size_t offset) {
                           return offset >= editedDisplay.size() || editedDisplay[offset] != '\n';
                       }),
        hardBreakOffsets_.end());

    std::string canonical = std::move(editedDisplay);
    for (std::size_t offset = 0; offset < canonical.size(); ++offset) {
        if (canonical[offset] == '\n' && !isHardBreak(offset)) canonical[offset] = ' ';
    }
    editLength_ = canonical.size();
    editPending_ = false;
    rewrap(std::move(canonical));
}

void SoftWrappedText::rewrap(std::string canonical) {
    displayText_ = std::move(canonical);
    softBreakOffsets_.clear();
    if (wrapColumns_ == 0) return;

    std::size_t lineStart = 0;
    std::size_t column = 0;
    std::size_t lastSpace = std::string::npos;
    for (std::size_t offset = 0; offset < displayText_.size(); ++offset) {
        if (displayText_[offset] == '\n' && isHardBreak(offset)) {
            lineStart = offset + 1;
            column = 0;
            lastSpace = std::string::npos;
            continue;
        }
        if (displayText_[offset] == ' ') lastSpace = offset;
        ++column;
        if (column <= wrapColumns_ || lastSpace == std::string::npos || lastSpace < lineStart)
            continue;

        displayText_[lastSpace] = '\n';
        softBreakOffsets_.push_back(lastSpace);
        lineStart = lastSpace + 1;
        column = offset - lastSpace;
        lastSpace = std::string::npos;
        for (std::size_t scan = lineStart; scan <= offset; ++scan) {
            if (displayText_[scan] == ' ') lastSpace = scan;
        }
    }
}

void ComposerDraft::setText(std::string value, std::size_t wrapColumns) {
    text = SoftWrappedText(std::move(value), wrapColumns);
    editBuffer = text.displayText();
}

void ComposerDraft::clear() {
    text.setCanonical({});
    images.clear();
    editBuffer.clear();
}

ComposerDraft& DraftStore::forSession(std::string_view sessionPath) {
    if (const auto found = drafts_.find(sessionPath); found != drafts_.end())
        return found->second;
    return drafts_.try_emplace(std::string(sessionPath)).first->second;
}

const ComposerDraft* DraftStore::find(std::string_view sessionPath) const noexcept {
    const auto it = drafts_.find(sessionPath);
    return it == drafts_.end() ? nullptr : &it->second;
}

void DraftStore::erase(std::string_view sessionPath) {
    if (const auto found = drafts_.find(sessionPath); found != drafts_.end()) drafts_.erase(found);
}

bool DraftStore::dirty(std::string_view sessionPath) const noexcept {
    const ComposerDraft* value = find(sessionPath);
    return value != nullptr && value->dirty();
}

void ScrollLock::observe(float scrollY, float scrollMaxY, bool userScrolled) {
    constexpr float kBottomSlop = 2.0f;
    const float distance = std::max(0.0f, scrollMaxY - scrollY);
    if (userScrolled && distance > kBottomSlop) locked_ = false;
    if (distance <= kBottomSlop) locked_ = true;
}

CopilotView::CopilotView(DesktopStore& store, CopilotActions actions)
    : store_(store), actions_(std::move(actions)) {
    if (store_.activeSessionPath()) sessionPath_ = *store_.activeSessionPath();
    refreshProjection();
}

void CopilotView::setSessionPath(std::string_view sessionPath) {
    if (sessionPath_ == sessionPath) {
        refreshProjection();
        return;
    }
    sessionPath_ = std::string(sessionPath);
    composerSelectionFirst_ = 0;
    composerSelectionLast_ = 0;
    uiResponse_.clear();
    selectedAgentId_.clear();
    ComposerDraft& value = drafts_.forSession(sessionPath_);
    value.editBuffer = value.text.displayText();
    refreshProjection();
}

ComposerDraft& CopilotView::draft() { return drafts_.forSession(sessionPath_); }
ComposerDraft& CopilotView::draft(std::string_view sessionPath) {
    return drafts_.forSession(sessionPath);
}

std::span<const SessionTabView> CopilotView::sessionTabs() const {
    const auto& tabs = store_.tabs();
    bool stale = tabProjection_.size() != tabs.size();
    if (!stale) {
        for (std::size_t index = 0; index < tabs.size(); ++index) {
            const DesktopSessionTab& source = tabs[index];
            const SessionTabView& cached = tabProjection_[index];
            const bool active = sessionPath_.empty() ? source.active
                                                     : source.path == sessionPath_;
            const bool dirty = source.draftDirty || drafts_.dirty(source.path);
            if (cached.path != source.path || cached.title != source.title ||
                cached.active != active || cached.running != source.running ||
                cached.unread != source.unread || cached.draftDirty != dirty) {
                stale = true;
                break;
            }
        }
    }

    if (stale) {
        tabProjection_.clear();
        tabProjection_.reserve(tabs.size());
        for (const DesktopSessionTab& tab : tabs) {
            SessionTabView view;
            view.path = tab.path;
            view.title = tab.title;
            view.active = sessionPath_.empty() ? tab.active : tab.path == sessionPath_;
            view.running = tab.running;
            view.unread = tab.unread;
            view.draftDirty = tab.draftDirty || drafts_.dirty(tab.path);
            view.closeGuard = closeGuard(tab.path);
            tabProjection_.push_back(std::move(view));
        }
    }
    return {tabProjection_.data(), tabProjection_.size()};
}

CloseGuard CopilotView::closeGuard(std::string_view sessionPath) const {
    bool running = false;
    bool dirty = drafts_.dirty(sessionPath);
    for (const DesktopSessionTab& tab : store_.tabs()) {
        if (tab.path != sessionPath) continue;
        running = tab.running;
        dirty = dirty || tab.draftDirty;
        break;
    }
    if (running && dirty)
        return {CloseBlock::RunningAndDraft, "Session is running and has an unsent draft"};
    if (running) return {CloseBlock::Running, "Session is still running"};
    if (dirty) return {CloseBlock::Draft, "Session has an unsent draft"};
    return {};
}

bool CopilotView::switchSession(std::string_view sessionPath) {
    if (sessionPath.empty()) return false;
    setSessionPath(sessionPath);
    return dispatch("session.activate", {{"path", std::string(sessionPath)}});
}

bool CopilotView::closeSession(std::string_view sessionPath, bool force) {
    if (sessionPath.empty()) return false;
    if (!force && !closeGuard(sessionPath).canClose()) return false;
    const std::string target(sessionPath);
    Json params{{"path", target}};
    if (force) params["force"] = true;
    return dispatch("session.tab.close", std::move(params),
                    [this, target](const ResponseFrame& response) {
                        if (!response.result || response.error ||
                            !response.result->value("closed", false))
                            return;
                        drafts_.erase(target);
                    });
}

bool CopilotView::newSession(std::string_view cwd) {
    if (cwd.empty()) return false;
    return dispatch("session.new", {{"cwd", std::string(cwd)}});
}

bool CopilotView::dispatch(std::string method, Json params, CopilotActions::Response response) {
    if (!actions_.request) return false;
    actions_.request(std::move(method), std::move(params), std::move(response));
    return true;
}

bool CopilotView::submit() {
    if (sessionPath_.empty()) return false;
    ComposerDraft& value = draft();
    const std::string text = value.text.canonicalText();
    if (text.empty() && value.images.empty()) return false;

    Json images = Json::array();
    for (const ImageContent& image : value.images)
        images.push_back({{"type", "image"}, {"data", image.data}, {"mimeType", image.mimeType}});
    Json params{{"sessionPath", sessionPath_}, {"text", text}};
    if (!images.empty()) params["images"] = std::move(images);
    const std::string target = sessionPath_;
    return dispatch("prompt.send", std::move(params),
                    [this, target](const ResponseFrame& response) {
                        if (!response.result || response.error ||
                            !response.result->value("accepted", false))
                            return;
                        drafts_.forSession(target).clear();
                        notifyDraftDirty(target, false);
                    });
}

bool CopilotView::stop() {
    if (sessionPath_.empty()) return false;
    return dispatch("run.abort", {{"sessionPath", sessionPath_}});
}

bool CopilotView::respondToUi(std::string value) {
    if (sessionPath_.empty() || !projection_.uiRequest) return false;
    const std::int64_t requestId = projection_.uiRequest->reqId;
    return dispatch("ui.respond",
                    {{"sessionPath", sessionPath_}, {"reqId", requestId},
                     {"value", std::move(value)}});
}

bool CopilotView::commandAgent(std::string_view agentId, std::string_view command,
                               std::string text) {
    if (sessionPath_.empty() || agentId.empty() ||
        (command != "chat" && command != "kill" && command != "revive"))
        return false;
    Json params{{"sessionPath", sessionPath_}, {"cmd", std::string(command)},
                {"agentId", std::string(agentId)}};
    if (!text.empty()) params["text"] = std::move(text);
    return dispatch("agent.command", std::move(params));
}

bool CopilotView::requestAgentTranscript(std::string_view agentId, std::int64_t fromByte) {
    if (sessionPath_.empty() || agentId.empty() || fromByte < 0) return false;
    const std::string target(agentId);
    return dispatch("agent.transcript",
                    {{"sessionPath", sessionPath_}, {"agentId", target},
                     {"fromByte", fromByte}},
                    [this, target](const ResponseFrame& response) {
                        if (!response.result || response.error) return;
                        const auto text = response.result->find("text");
                        if (text != response.result->end() && text->is_string())
                            agentTranscripts_[target] = text->get<std::string>();
                    });
}

void CopilotView::attachImage(ImageContent image) {
    if (sessionPath_.empty() || image.data.empty() || image.mimeType.empty()) return;
    const bool wasDirty = draft().dirty();
    draft().images.push_back(std::move(image));
    if (!wasDirty) notifyDraftDirty(sessionPath_, true);
}

std::string_view CopilotView::agentTranscript(std::string_view agentId) const noexcept {
    const auto it = agentTranscripts_.find(agentId);
    return it == agentTranscripts_.end() ? std::string_view{} : std::string_view(it->second);
}

void CopilotView::notifyDraftDirty(std::string_view path, bool dirty) {
    dispatch("session.tab.draft", {{"path", std::string(path)}, {"dirty", dirty}});
}

void CopilotView::refreshProjection() {
    const SessionSnapshot* snapshot = store_.session(sessionPath_);
    if (snapshot == nullptr) {
        if (projectionStamp_.source != nullptr) {
            projection_ = {};
            projectionStamp_ = {};
        }
        return;
    }

    ProjectionStamp stamp;
    stamp.source = snapshot;
    stamp.entryCount = snapshot->entries.size();
    if (!snapshot->entries.empty()) stamp.lastEntryId = snapshot->entries.back().id;
    if (snapshot->latestAgentEvent) {
        stamp.agentEventType = snapshot->latestAgentEvent->type;
        stamp.agentEventHash = std::hash<Json>{}(snapshot->latestAgentEvent->payload);
    }
    if (snapshot->state) {
        stamp.hasState = true;
        stamp.streaming = snapshot->state->isStreaming;
        stamp.aborting = snapshot->state->isAborting.value_or(false);
        stamp.queued = snapshot->state->queuedMessageCount;
    }
    if (snapshot->uiRequest) {
        stamp.uiRequestId = snapshot->uiRequest->reqId;
        stamp.uiRequestHash = std::hash<Json>{}(snapshot->uiRequest->payload);
    }
    if (stamp == projectionStamp_) return;
    projection_ = TranscriptProjection::from(*snapshot);
    projectionStamp_ = std::move(stamp);
}


void CopilotView::drawRow(const TranscriptRow& row) {
    ImGui::PushID(row.id.c_str());
    const kit::Tone tone = toneFor(row);
    if (row.kind == TranscriptKind::Assistant || row.kind == TranscriptKind::User ||
        row.kind == TranscriptKind::UiRequest) {
        kit::CardOptions options;
        options.title = row.title.c_str();
        options.tint = tone;
        const bool open = kit::cardBegin("##transcript-card", options);
        if (open) {
            if (!row.text.empty()) ImGui::TextWrapped("%s", row.text.c_str());
            if (!row.meta.empty()) kit::dimText(row.meta.c_str());
        }
        kit::cardEnd();
    } else {
        kit::RowStyle style;
        style.iconTone = tone;
        style.minimumHeight = ImGui::GetFrameHeight();
        (void)kit::rowBegin("##transcript-row", style);
        if (row.live) {
            kit::statusGlyphInline(kit::Status::Running);
            ImGui::SameLine();
        } else if (row.failed) {
            kit::statusGlyphInline(kit::Status::Failed);
            ImGui::SameLine();
        }
        ImGui::TextUnformatted(row.title.c_str());
        if (!row.text.empty()) {
            if (row.kind == TranscriptKind::Thinking || row.kind == TranscriptKind::Status)
                kit::dimText(row.text.c_str());
            else
                ImGui::TextWrapped("%s", row.text.c_str());
        }
        kit::rowEnd();
    }
    ImGui::PopID();
}

void CopilotView::drawTranscript(float height) {
    ImGui::BeginChild("##transcript", ImVec2(0.0f, height), ImGuiChildFlags_Borders,
                      ImGuiWindowFlags_None);
    if (projection_.rows.empty()) {
        (void)kit::emptyState("No messages yet",
                              "Ask a question or attach an image to begin.");
    } else {
        kit::DensityScope compact(kit::Density::Compact);
        for (const TranscriptRow& row : projection_.rows) drawRow(row);
    }

    const bool userScrolled = ImGui::IsWindowHovered() && ImGui::GetIO().MouseWheel != 0.0f;
    scrollLock_.observe(ImGui::GetScrollY(), ImGui::GetScrollMaxY(), userScrolled);
    if (scrollLock_.locked()) ImGui::SetScrollY(ImGui::GetScrollMaxY());
    ImGui::EndChild();
}

void CopilotView::drawAgents() {
    const SessionSnapshot* snapshot = store_.session(sessionPath_);
    if (snapshot == nullptr || snapshot->agents.empty()) {
        (void)kit::emptyState("No agents",
                              "Subagents will appear here when they are delegated work.");
        return;
    }
    for (const AgentSnapshot& agent : snapshot->agents) {
        ImGui::PushID(agent.id.c_str());
        const bool selected = selectedAgentId_ == agent.id;
        kit::RowStyle style;
        style.selected = selected;
        const bool clicked = kit::rowBegin("##agent", style);
        const kit::Status status = agent.status == AgentSnapshot::Status::Running
                                       ? kit::Status::Running
                                       : agent.status == AgentSnapshot::Status::Aborted
                                             ? kit::Status::Failed
                                             : kit::Status::Done;
        kit::statusGlyphInline(status);
        ImGui::SameLine();
        ImGui::TextUnformatted(agent.displayName.c_str());
        ImGui::SameLine();
        const char* statusText = agent.status == AgentSnapshot::Status::Running
                                     ? "running"
                                     : agent.status == AgentSnapshot::Status::Idle
                                           ? "idle"
                                           : agent.status == AgentSnapshot::Status::Parked
                                                 ? "parked"
                                                 : "aborted";
        kit::dimText(statusText);
        kit::rowEnd();
        if (clicked) selectedAgentId_ = selected ? std::string{} : agent.id;

        if (selectedAgentId_ == agent.id) {
            kit::CardOptions options{"Agent controls", nullptr, kit::Tone::Neutral, false};
            const bool body = kit::cardBegin("##agent-controls", options);
            if (body) {
                std::string& message = agentMessages_[agent.id];
                ImGui::SetNextItemWidth(std::max(
                    ui::metrics::U(20.0f),
                    ImGui::GetContentRegionAvail().x - ui::metrics::U(22.0f)));
                inputTextString("##agent-message", message);
                ImGui::SameLine();
                if (kit::secondaryButton("Send") && !message.empty()) {
                    commandAgent(agent.id, "chat", message);
                    message.clear();
                }
                if (kit::secondaryButton("Transcript")) requestAgentTranscript(agent.id);
                ImGui::SameLine();
                if (agent.status == AgentSnapshot::Status::Parked ||
                    agent.status == AgentSnapshot::Status::Aborted) {
                    if (kit::secondaryButton("Revive")) commandAgent(agent.id, "revive");
                } else if (kit::dangerButton("Kill")) {
                    commandAgent(agent.id, "kill");
                }
            }
            kit::cardEnd();
            if (const std::string_view transcript = agentTranscript(agent.id);
                !transcript.empty()) {
                kit::CardOptions transcriptOptions{
                    "Transcript", nullptr, kit::Tone::Neutral, false};
                const bool transcriptBody =
                    kit::cardBegin("##agent-transcript", transcriptOptions);
                if (transcriptBody) {
                    ImGui::PushTextWrapPos(0.0f);
                    ImGui::TextUnformatted(transcript.data(),
                                           transcript.data() + transcript.size());
                    ImGui::PopTextWrapPos();
                }
                kit::cardEnd();
            }
        }
        ImGui::PopID();
    }
}

void CopilotView::drawTasks() {
    if (projection_.tasks.empty()) {
        (void)kit::emptyState("No tasks",
                              "Tasks and todo updates from the active run appear here.");
        return;
    }
    for (const TaskItem& task : projection_.tasks) {
        ImGui::PushID(task.id.c_str());
        kit::RowStyle style;
        style.secondary = task.phase.empty() ? nullptr : task.phase.c_str();
        style.meta = statusLabel(task.state);
        (void)kit::row("##task", task.title.c_str(), style);
        ImGui::PopID();
    }
}

void CopilotView::drawSessions() {
    std::string newSessionCwd;
    if (const SessionSnapshot* snapshot = store_.session(sessionPath_)) {
        if (snapshot->state) newSessionCwd = snapshot->state->cwd;
        else if (snapshot->header) newSessionCwd = snapshot->header->cwd;
    }
    if (!newSessionCwd.empty() && kit::primaryButton("New session"))
        dispatch("session.new", {{"cwd", newSessionCwd}});

    if (store_.sessions().empty()) {
        (void)kit::emptyState("No saved sessions", "New and recent sessions appear here.");
        return;
    }
    for (const DesktopSessionInfo& session : store_.sessions()) {
        ImGui::PushID(session.path.c_str());
        kit::RowStyle style;
        style.secondary = session.cwd.c_str();
        style.meta = session.pinned.value_or(false) ? "pinned" : nullptr;
        (void)kit::rowBegin("##session", style);
        const std::string title = session.title.value_or(session.id);
        ImGui::TextUnformatted(title.c_str());
        std::string& rename = sessionRenames_[session.path];
        if (rename.empty()) rename = title;
        ImGui::SetNextItemWidth(std::max(ui::metrics::U(16.0f),
                                        ImGui::GetContentRegionAvail().x -
                                            ui::metrics::U(17.0f)));
        inputTextString("##rename", rename);
        ImGui::SameLine();
        if (kit::secondaryButton("Rename", {}, !rename.empty() && rename != title))
            dispatch("session.rename", {{"path", session.path}, {"title", rename}});
        if (kit::secondaryButton("Open")) {
            setSessionPath(session.path);
            dispatch("session.select", {{"path", session.path}});
        }
        ImGui::SameLine();
        if (kit::secondaryButton("Fork"))
            dispatch("session.fork", {{"path", session.path}});
        ImGui::SameLine();
        if (kit::secondaryButton(session.pinned.value_or(false) ? "Unpin" : "Pin"))
            dispatch("session.pin", {{"path", session.path},
                                      {"pinned", !session.pinned.value_or(false)}});
        ImGui::SameLine();
        if (kit::dangerButton("Delete"))
            dispatch("session.delete", {{"path", session.path}});
        kit::rowEnd();
        ImGui::PopID();
    }
}


void CopilotView::drawUiRequest() {
    if (!projection_.uiRequest) return;
    const UiRequest& request = *projection_.uiRequest;
    ImGui::PushID(static_cast<int>(request.reqId));
    kit::CardOptions options;
    options.title = request.title.c_str();
    options.tint = kit::Tone::Warn;
    const bool open = kit::cardBegin("##ui-request", options);
    if (open) {
        const std::string prompt = firstString(request.payload,
                                               {"message", "prompt", "question", "description"});
        if (!prompt.empty()) ImGui::TextWrapped("%s", prompt.c_str());
        if (containsWord(request.kind, "permission")) {
            if (kit::primaryButton("Allow")) respondToUi("allow");
            ImGui::SameLine();
            if (kit::dangerButton("Deny")) respondToUi("deny");
        } else if (request.payload.contains("options") && request.payload["options"].is_array()) {
            for (const auto& option : request.payload["options"]) {
                std::string label;
                std::string value;
                if (option.is_string()) {
                    label = value = option.get<std::string>();
                } else if (option.is_object()) {
                    label = option.value("label", option.value("value", "Option"));
                    value = option.value("value", label);
                }
                if (label.empty()) continue;
                if (kit::secondaryButton(label.c_str())) respondToUi(value);
                ImGui::SameLine();
            }
            ImGui::NewLine();
        } else {
            ImGui::SetNextItemWidth(-1.0f);
            inputTextString("##ui-response", uiResponse_);
            if (kit::primaryButton("Respond", {}, !uiResponse_.empty())) {
                respondToUi(uiResponse_);
                uiResponse_.clear();
            }
        }
    }
    kit::cardEnd();
    ImGui::PopID();
}

int CopilotView::composerInputCallback(ImGuiInputTextCallbackData* data) {
    auto* context = static_cast<ComposerCallbackContext*>(data->UserData);
    if (data->EventFlag == ImGuiInputTextFlags_CallbackResize) {
        context->buffer->resize(static_cast<std::size_t>(data->BufTextLen));
        data->Buf = context->buffer->data();
        return 0;
    }
    if (data->EventFlag == ImGuiInputTextFlags_CallbackCharFilter && data->EventChar == '\n') {
        const ImGuiIO& io = ImGui::GetIO();
        const bool paste = (io.KeyCtrl || io.KeySuper) && ImGui::IsKeyDown(ImGuiKey_V);
        if (!io.KeyShift && !paste) {
            context->view->composerSubmitRequested_ = true;
            return 1;
        }
    }
    if (data->EventFlag == ImGuiInputTextFlags_CallbackEdit) {
        context->draft->text.recordEdit(
            std::string_view(data->Buf, static_cast<std::size_t>(data->BufTextLen)),
            static_cast<std::size_t>(data->CursorPos));
    }
    if (data->EventFlag == ImGuiInputTextFlags_CallbackAlways) {
        const ImGuiIO& io = ImGui::GetIO();
        const bool shortcut = io.KeyCtrl || io.KeySuper;
        const bool copying = shortcut && ImGui::IsKeyPressed(ImGuiKey_C, false);
        const bool cutting = shortcut && ImGui::IsKeyPressed(ImGuiKey_X, false);
        std::size_t first = static_cast<std::size_t>(std::min(data->SelectionStart,
                                                              data->SelectionEnd));
        std::size_t last = static_cast<std::size_t>(std::max(data->SelectionStart,
                                                             data->SelectionEnd));
        if (cutting && first == last) {
            first = context->view->composerSelectionFirst_;
            last = context->view->composerSelectionLast_;
        }
        if ((copying || cutting) && last > first) {
            const std::string copy = context->draft->text.copyRange(first, last);
            ImGui::SetClipboardText(copy.c_str());
        }
        context->view->composerSelectionFirst_ =
            static_cast<std::size_t>(std::min(data->SelectionStart, data->SelectionEnd));
        context->view->composerSelectionLast_ =
            static_cast<std::size_t>(std::max(data->SelectionStart, data->SelectionEnd));
    }
    return 0;
}

void CopilotView::drawComposer() {
    ComposerDraft& value = draft();
    const float glyphWidth = std::max(1.0f, ImGui::CalcTextSize("M").x);
    const std::size_t columns = static_cast<std::size_t>(
        std::max(8.0f, std::floor(ImGui::GetContentRegionAvail().x / glyphWidth) - 2.0f));
    value.text.setWrapColumns(columns);
    if (value.editBuffer != value.text.displayText()) value.editBuffer = value.text.displayText();
    value.editBuffer.reserve(std::max<std::size_t>(value.editBuffer.size() + 1024, 4096));

    if (!value.images.empty()) {
        for (std::size_t index = 0; index < value.images.size(); ++index) {
            ImGui::PushID(static_cast<int>(index));
            if (index != 0) ImGui::SameLine();
            const std::string label = value.images[index].mimeType + " image";
            if (kit::chip(label.c_str(), kit::Tone::Info)) {
                value.images.erase(value.images.begin() + static_cast<std::ptrdiff_t>(index));
                if (!value.dirty()) notifyDraftDirty(sessionPath_, false);
                ImGui::PopID();
                break;
            }
            ImGui::PopID();
        }
    }

    const bool wasDirty = value.dirty();
    ComposerCallbackContext context{this, &value, &value.editBuffer};
    composerSubmitRequested_ = false;
    const ImGuiInputTextFlags flags = ImGuiInputTextFlags_CallbackResize |
                                      ImGuiInputTextFlags_CallbackCharFilter |
                                      ImGuiInputTextFlags_CallbackEdit |
                                      ImGuiInputTextFlags_CallbackAlways |
                                      ImGuiInputTextFlags_AllowTabInput;
    const std::size_t visibleLines = std::clamp<std::size_t>(
        1U + static_cast<std::size_t>(std::count(value.editBuffer.begin(),
                                                  value.editBuffer.end(), '\n')),
        1U, ui::metrics::kComposerMaxLines);
    const bool streaming = store_.session(sessionPath_) && store_.session(sessionPath_)->state &&
                           store_.session(sessionPath_)->state->isStreaming;
    const float composerHeight =
        ImGui::GetTextLineHeightWithSpacing() * static_cast<float>(visibleLines + 1U);
    const float actionWidth = ui::metrics::px(64.0F);
    const float inputWidth =
        std::max(ui::metrics::px(80.0F),
                 ImGui::GetContentRegionAvail().x - actionWidth - ui::metrics::px(8.0F));
    const float inputY = ImGui::GetCursorPosY();
    const bool changed = ImGui::InputTextMultiline(
        "##composer", value.editBuffer.data(), value.editBuffer.capacity() + 1,
        ImVec2(inputWidth, composerHeight), flags, composerInputCallback, &context);
    const bool inputActive = ImGui::IsItemActive();
    const ImVec2 inputMinimum = ImGui::GetItemRectMin();
    value.editBuffer.resize(std::strlen(value.editBuffer.c_str()));
    if (changed) {
        value.text.applyEdited(value.editBuffer);
        value.editBuffer = value.text.displayText();
        if (wasDirty != value.dirty()) notifyDraftDirty(sessionPath_, value.dirty());
    }
    if (value.editBuffer.empty() && !inputActive) {
        ImGui::GetWindowDrawList()->AddText(
            {inputMinimum.x + ui::metrics::px(8.0F),
             inputMinimum.y + ui::metrics::px(8.0F)},
            ui::toU32(ui::palette().textDisabled), "Ask anything...");
    }

    ImGui::SameLine(0.0F, ui::metrics::px(8.0F));
    ImGui::SetCursorPosY(inputY +
                         std::max(0.0F, (composerHeight - ImGui::GetFrameHeight()) * 0.5F));
    if (streaming) {
        if (kit::dangerButton("Stop", {actionWidth, 0.0F})) stop();
    } else if (kit::primaryButton("Send", {actionWidth, 0.0F}, value.dirty())) {
        submit();
    }
    if (composerSubmitRequested_ && value.dirty()) submit();
}

void CopilotView::drawTranscriptPanel(ImVec2 size) {
    if (sessionPath_.empty() && store_.activeSessionPath())
        setSessionPath(*store_.activeSessionPath());
    refreshProjection();
    ImGui::PushID(this);
    ImGui::BeginChild("##copilot-transcript-panel", size, ImGuiChildFlags_None,
                      ImGuiWindowFlags_NoScrollbar);
    drawTranscript(0.0f);
    ImGui::EndChild();
    ImGui::PopID();
}

void CopilotView::drawAgentsPanel(ImVec2 size) {
    if (sessionPath_.empty() && store_.activeSessionPath())
        setSessionPath(*store_.activeSessionPath());
    refreshProjection();
    ImGui::PushID(this);
    ImGui::BeginChild("##copilot-agents-panel", size, ImGuiChildFlags_None);
    drawAgents();
    ImGui::EndChild();
    ImGui::PopID();
}

void CopilotView::drawTasksPanel(ImVec2 size) {
    if (sessionPath_.empty() && store_.activeSessionPath())
        setSessionPath(*store_.activeSessionPath());
    refreshProjection();
    ImGui::PushID(this);
    ImGui::BeginChild("##copilot-tasks-panel", size, ImGuiChildFlags_None);
    drawTasks();
    ImGui::EndChild();
    ImGui::PopID();
}

void CopilotView::drawSessionsPanel(ImVec2 size) {
    if (sessionPath_.empty() && store_.activeSessionPath())
        setSessionPath(*store_.activeSessionPath());
    refreshProjection();
    ImGui::PushID(this);
    ImGui::BeginChild("##copilot-sessions-panel", size, ImGuiChildFlags_None);
    drawSessions();
    ImGui::EndChild();
    ImGui::PopID();
}

void CopilotView::drawComposerPanel(ImVec2 size) {
    if (sessionPath_.empty() && store_.activeSessionPath())
        setSessionPath(*store_.activeSessionPath());
    refreshProjection();
    ImGui::PushID(this);
    ImGui::BeginChild("##copilot-composer-panel", size, ImGuiChildFlags_None,
                      ImGuiWindowFlags_NoScrollbar);
    drawUiRequest();
    drawComposer();
    ImGui::EndChild();
    ImGui::PopID();
}


}  // namespace chud::copilot
