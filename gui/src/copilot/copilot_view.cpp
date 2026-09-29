#include "copilot/copilot_view.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <initializer_list>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "graph/session_dag.h"
#include "icons/icons.h"
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

// Session ids are minted as "<ISO-8601 UTC>_<uuid>" with ':' and '.' rewritten
// to '-'. Only the leading timestamp means anything to a human, so a titleless
// row shows a local date/time and degrades to a short prefix when the id does
// not parse.
bool idDigits(const std::string& id, std::size_t offset, std::size_t count, int& out) {
    if (offset + count > id.size()) return false;
    int value = 0;
    for (std::size_t index = 0; index < count; ++index) {
        const char digit = id[offset + index];
        if (digit < '0' || digit > '9') return false;
        value = value * 10 + (digit - '0');
    }
    out = value;
    return true;
}

// The whole binding list never fits beside Send in a panel capped near px(430),
// so the composer paints the widest form that measures inside the space it has
// and keeps every binding in a hover tooltip. Ordered widest first.
constexpr const char* kHintTiers[] = {
    "Enter send  Shift+Enter newline  Ctrl/Cmd+A/C/X/V/Z/Y",
    "Enter send  Shift+Enter newline",
    "Enter send",
};
constexpr const char* kHintTooltip =
    "Enter: send\n"
    "Shift+Enter: newline\n"
    "Ctrl/Cmd + A select all, C copy, X cut, V paste, Z undo, Y redo";

// Index of the widest hint that measures inside `width`. The narrowest tier is
// the floor: a hint that has to wrap still beats a truncated one.
int fittingHint(float width) {
    for (int index = 0; index + 1 < IM_ARRAYSIZE(kHintTiers); ++index)
        if (ImGui::CalcTextSize(kHintTiers[index]).x <= width) return index;
    return IM_ARRAYSIZE(kHintTiers) - 1;
}

// Percent tiers come from the cross-product ui::shared contract (one
// authority, verified against the shared manifest); the absolute-token clamps
// mirror the TUI status line
// (packages/coding-agent/src/modes/components/status-line/context-thresholds.ts).
// Each tier fires at min(percent-of-window, absolute-token) pressure; the
// token clamps make huge windows go amber/red while their percentage still
// looks comfortable.
constexpr double kUsageWarnPercent =
    static_cast<double>(ui::shared::kUsageThresholds.warning) * 100.0;
constexpr double kUsageWarnTokens = 150000.0;
constexpr double kUsageErrPercent =
    static_cast<double>(ui::shared::kUsageThresholds.critical) * 100.0;
constexpr double kUsageErrTokens = 500000.0;

std::optional<double> usagePercentOf(const ContextUsage& usage) {
    if (usage.percent && std::isfinite(*usage.percent)) return *usage.percent;
    if (usage.tokens && usage.contextWindow && *usage.contextWindow > 0) {
        return 100.0 * static_cast<double>(*usage.tokens) /
               static_cast<double>(*usage.contextWindow);
    }
    return std::nullopt;
}

bool reachesUsageThreshold(double percent, std::int64_t window,
                           double percentThreshold, double tokenThreshold) {
    if (percent <= 0.0) return false;
    if (window <= 0) return percent >= percentThreshold;
    return percent >= std::min(percentThreshold,
                               tokenThreshold / static_cast<double>(window) * 100.0);
}

// One spelling for token quantities: "812", "12.3k", "1.2M".
std::string fmtTokens(std::int64_t tokens) {
    char text[32];
    if (tokens < 1000) {
        std::snprintf(text, sizeof text, "%lld", static_cast<long long>(tokens));
    } else if (tokens < 1000000) {
        std::snprintf(text, sizeof text, "%.1fk",
                      static_cast<double>(tokens) / 1000.0);
    } else {
        std::snprintf(text, sizeof text, "%.1fM",
                      static_cast<double>(tokens) / 1000000.0);
    }
    return text;
}

enum class ButtonKind { Primary, Secondary, Danger };

bool kitButton(ButtonKind kind, const char* label, ImVec2 size, bool enabled,
               const char* disabledReason) {
    switch (kind) {
    case ButtonKind::Primary: return kit::primaryButton(label, size, enabled, disabledReason);
    case ButtonKind::Danger: return kit::dangerButton(label, size, enabled, disabledReason);
    case ButtonKind::Secondary: break;
    }
    return kit::secondaryButton(label, size, enabled, disabledReason);
}

// Icon-backed action button: a frame-height square kit button carrying the
// action's atlas icon, with the accessible label in a REQUIRED tooltip
// (docs/UI_FOUNDATION.md §7/§10). When the atlas is not loaded (headless run,
// missing assets) it degrades to the full-text kit button — an action never
// renders as an empty square. Callers wrap rows in PushID, so `label` doubles
// as the ImGui id.
bool iconActionButton(Action action, const char* label, ButtonKind kind,
                      bool enabled = true, const char* disabledReason = nullptr) {
    if (!icons::iconsLoaded()) return kitButton(kind, label, {}, enabled, disabledReason);

    std::string id("##icon-action-");
    id += label;
    const float side = ImGui::GetFrameHeight();
    const bool pressed = kitButton(kind, id.c_str(), ImVec2(side, side), enabled,
                                   disabledReason);
    const ImVec2 rectMin = ImGui::GetItemRectMin();
    const float iconPx = std::min(side - ui::metrics::px(6.0f), ui::metrics::px(20.0f));
    const float inset = (side - iconPx) * 0.5f;
    // Identity tint: the atlas is theme-baked (§6); disabled state dims it.
    const ImU32 tint = enabled ? IM_COL32_WHITE
                               : ImGui::GetColorU32(ImGuiCol_Text,
                                                    ui::palette().textDisabled.w);
    icons::drawIcon(ImGui::GetWindowDrawList(), actionIconName(action),
                    ImVec2(rectMin.x + inset, rectMin.y + inset), iconPx, tint);
    // The accessible label. When disabled, the kit button already tooltips the
    // disabled reason; do not fight it.
    if ((enabled || disabledReason == nullptr) &&
        ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) {
        ImGui::SetTooltip("%s", label);
    }
    return pressed;
}

}  // namespace

/// Local date/time for a session id, or nullopt when `id` does not start with a
/// session-id timestamp.
///
/// Callers holding only a tab title need this distinction: a title is either a
/// human-chosen name, which must be shown verbatim, or the server's fallback to
/// the raw session id, which must be made readable.
std::optional<std::string> sessionStamp(const std::string& id) {
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    if (!idDigits(id, 0, 4, year) || !idDigits(id, 5, 2, month) ||
        !idDigits(id, 8, 2, day) || !idDigits(id, 11, 2, hour) ||
        !idDigits(id, 14, 2, minute))
        return std::nullopt;
    if (id[4] != '-' || id[7] != '-' || id[10] != 'T' || id[13] != '-') return std::nullopt;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
        return std::nullopt;

    std::tm utc{};
    utc.tm_year = year - 1900;
    utc.tm_mon = month - 1;
    utc.tm_mday = day;
    utc.tm_hour = hour;
    utc.tm_min = minute;
#ifdef _WIN32
    const std::time_t epoch = _mkgmtime(&utc);
    std::tm local{};
    if (epoch == static_cast<std::time_t>(-1) || localtime_s(&local, &epoch) != 0)
        return std::nullopt;
#else
    const std::time_t epoch = timegm(&utc);
    std::tm local{};
    if (epoch == static_cast<std::time_t>(-1) || localtime_r(&epoch, &local) == nullptr)
        return std::nullopt;
#endif
    // Numeric fields only: month names would follow the process locale.
    char text[24];
    if (std::strftime(text, sizeof text, "%Y-%m-%d %H:%M", &local) == 0) return std::nullopt;
    return std::string(text);
}

std::string sessionLabel(const std::string& id) {
    if (const std::optional<std::string> stamp = sessionStamp(id)) return *stamp;
    if (id.empty()) return "Untitled session";
    constexpr std::size_t kPrefix = 12;
    return id.size() > kPrefix ? id.substr(0, kPrefix) + "…" : id;
}

const char* actionIconName(Action action) noexcept {
    switch (action) {
    case Action::Send: return "send";
    case Action::Stop: return "stop";
    case Action::AttachImage: return "attach";
    case Action::RemoveAttachment: return "close-tab";
    case Action::NewSession: return "new-session";
    case Action::OpenSession: return "open-folder";
    case Action::RenameSession: return "rename";
    case Action::ForkSession: return "fork";
    case Action::PinSession: return "pin";
    case Action::DeleteSession: return "delete";
    case Action::AgentMessage: return "send";
    case Action::AgentTranscript: return "terminal";
    case Action::AgentRevive: return "recovery";
    case Action::AgentKill: return "stop";
    }
    return "tool";
}

UsageLevel usageLevel(const ContextUsage& usage) noexcept {
    const std::optional<double> percent = usagePercentOf(usage);
    if (!percent) return UsageLevel::Unknown;
    const std::int64_t window = usage.contextWindow.value_or(0);
    if (reachesUsageThreshold(*percent, window, kUsageErrPercent, kUsageErrTokens))
        return UsageLevel::Err;
    if (reachesUsageThreshold(*percent, window, kUsageWarnPercent, kUsageWarnTokens))
        return UsageLevel::Warn;
    return UsageLevel::Ok;
}

std::optional<double> usageFraction(const ContextUsage& usage) noexcept {
    const std::optional<double> percent = usagePercentOf(usage);
    if (!percent) return std::nullopt;
    return std::clamp(*percent / 100.0, 0.0, 1.0);
}

std::string usageLabel(const ContextUsage& usage) {
    const std::optional<double> percent = usagePercentOf(usage);
    const std::int64_t window = usage.contextWindow.value_or(0);
    char text[64];
    if (percent && window > 0) {
        std::snprintf(text, sizeof text, "%.1f%% of %s", *percent,
                      fmtTokens(window).c_str());
        return text;
    }
    if (percent) {
        std::snprintf(text, sizeof text, "%.1f%% used", *percent);
        return text;
    }
    if (usage.tokens) {
        std::snprintf(text, sizeof text, "%s tokens / window unknown",
                      fmtTokens(*usage.tokens).c_str());
        return text;
    }
    return "context usage unknown";
}

std::vector<AgentTreeRow> agentHierarchy(const session_graph::SessionDag& dag) {
    using session_graph::NodeKind;

    std::vector<const session_graph::SessionDagNode*> agents;
    for (const session_graph::SessionDagNode& node : dag.nodes) {
        if (node.kind == NodeKind::Agent) agents.push_back(&node);
    }

    std::unordered_map<std::string_view, std::size_t> byId;
    byId.reserve(agents.size());
    for (std::size_t index = 0; index < agents.size(); ++index)
        byId.emplace(agents[index]->id, index);

    std::vector<std::vector<std::size_t>> children(agents.size());
    std::vector<std::size_t> roots;
    for (std::size_t index = 0; index < agents.size(); ++index) {
        const auto parent = byId.find(agents[index]->parentId);
        if (parent != byId.end() && parent->second != index)
            children[parent->second].push_back(index);
        else
            roots.push_back(index);  // parented to the session root (or orphan)
    }

    struct Frame {
        std::size_t index;
        int depth;
        std::uint32_t trunkMask;
        bool lastChild;
    };
    std::vector<AgentTreeRow> rows;
    rows.reserve(agents.size());
    std::vector<bool> visited(agents.size(), false);
    std::vector<Frame> stack;
    for (std::size_t position = roots.size(); position-- > 0;)
        stack.push_back({roots[position], 0, 0, position == roots.size() - 1});
    while (!stack.empty()) {
        const Frame frame = stack.back();
        stack.pop_back();
        if (visited[frame.index]) continue;  // defensive: malformed parent cycle
        visited[frame.index] = true;

        const session_graph::SessionDagNode& node = *agents[frame.index];
        rows.push_back({node.referenceId, node.label, node.detail, frame.depth,
                        node.orphan, node.recoverable, frame.lastChild,
                        frame.trunkMask});

        const std::vector<std::size_t>& kids = children[frame.index];
        const int childDepth = frame.depth + 1;
        const std::uint32_t childMask =
            frame.lastChild || frame.depth >= 31
                ? frame.trunkMask
                : frame.trunkMask | (1U << static_cast<unsigned>(frame.depth));
        for (std::size_t position = kids.size(); position-- > 0;)
            stack.push_back({kids[position], childDepth, childMask,
                             position == kids.size() - 1});
    }
    return rows;
}

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
    // The lightbox indexes into the previous session's draft; never let it
    // open onto another session's attachment.
    lightboxImage_.reset();
    lightboxOpened_ = false;
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

    std::unordered_map<std::string_view, const AgentSnapshot*> agentsById;
    agentsById.reserve(snapshot->agents.size());
    for (const AgentSnapshot& agent : snapshot->agents) agentsById.emplace(agent.id, &agent);

    // Grouping/orphan/recoverable state comes from the SessionDag the app
    // syncs each frame. Before the first sync (or headless) the flat fallback
    // still names every agent rather than hiding hierarchy behind a blank.
    std::vector<AgentTreeRow> rows;
    if (sessionDag_ != nullptr) rows = agentHierarchy(*sessionDag_);
    if (rows.empty()) {
        for (const AgentSnapshot& agent : snapshot->agents) {
            rows.push_back({agent.id, agent.displayName, {}, 0, false,
                            agent.status == AgentSnapshot::Status::Parked ||
                                agent.status == AgentSnapshot::Status::Aborted,
                            true, 0});
        }
    }

    const ui::Palette& p = ui::palette();
    const float indentStep = ui::metrics::U(4.0f);
    for (const AgentTreeRow& treeRow : rows) {
        const auto found = agentsById.find(treeRow.agentId);
        if (found == agentsById.end()) continue;  // dag lags a just-removed agent
        const AgentSnapshot& agent = *found->second;
        const int depth = std::min(treeRow.depth, 8);
        const float indent = indentStep * static_cast<float>(depth);

        ImGui::PushID(agent.id.c_str());
        kit::RowStyle style;
        style.actionsWidth = ui::metrics::U(42.0f);
        (void)kit::rowBegin("##agent", style);
        if (indent > 0.0f) ImGui::Indent(indent);
        kit::statusGlyphInline(agent.status == AgentSnapshot::Status::Running
                                   ? kit::Status::Running
                                   : agent.status == AgentSnapshot::Status::Aborted
                                         ? kit::Status::Failed
                                         : kit::Status::Done);
        ImGui::SameLine();
        ImGui::TextUnformatted(agent.displayName.c_str());
        if (treeRow.orphan) {
            ImGui::SameLine();
            (void)kit::chip("orphan", kit::Tone::Warn);
            if (ImGui::IsItemHovered())
                ImGui::SetTooltip("Parent agent is no longer part of this session");
        }
        if (treeRow.recoverable) {
            ImGui::SameLine();
            (void)kit::chip("recoverable", kit::Tone::Info);
            if (ImGui::IsItemHovered())
                ImGui::SetTooltip("Parked or failed agent — Revive resumes it");
        }
        if (!treeRow.detail.empty()) kit::dimText(treeRow.detail.c_str());
        std::string& message = agentMessages_[agent.id];
        ImGui::SetNextItemWidth(std::max(ui::metrics::U(20.0f),
                                        ImGui::GetContentRegionAvail().x - ui::metrics::U(34.0f)));
        inputTextString("##agent-message", message);
        ImGui::SameLine();
        if (iconActionButton(Action::AgentMessage, "Send message to this agent",
                             ButtonKind::Secondary, !message.empty(),
                             "Type a message for this agent first")) {
            commandAgent(agent.id, "chat", message);
            message.clear();
        }
        if (iconActionButton(Action::AgentTranscript, "Fetch agent transcript",
                             ButtonKind::Secondary))
            requestAgentTranscript(agent.id);
        ImGui::SameLine();
        if (agent.status == AgentSnapshot::Status::Parked ||
            agent.status == AgentSnapshot::Status::Aborted) {
            if (iconActionButton(Action::AgentRevive, "Revive this agent",
                                 ButtonKind::Secondary))
                commandAgent(agent.id, "revive");
        } else if (iconActionButton(Action::AgentKill, "Kill this agent",
                                    ButtonKind::Danger)) {
            commandAgent(agent.id, "kill");
        }
        if (indent > 0.0f) ImGui::Unindent(indent);
        kit::rowEnd();

        // Connectors after rowEnd: its reserving Dummy is the last item, so
        // the item rect is the full painted row (gap included) and vertical
        // trunks meet across rows with no seams.
        if (depth > 0) {
            const ImVec2 rowMin = ImGui::GetItemRectMin();
            const ImVec2 rowMax = ImGui::GetItemRectMax();
            ImDrawList* drawList = ImGui::GetWindowDrawList();
            const ImU32 edge = ui::toU32(agent.status == AgentSnapshot::Status::Running
                                             ? p.dagEdgeActive
                                             : p.dagEdge);
            const float stroke = ui::metrics::stroke();
            const float baseX = rowMin.x + kit::densityMetrics().padX;
            const auto laneX = [&](int lane) {
                return baseX + indentStep * (static_cast<float>(lane) + 0.5f);
            };
            for (int lane = 0; lane + 1 < depth; ++lane) {
                if ((treeRow.trunkMask & (1U << static_cast<unsigned>(lane))) != 0U)
                    drawList->AddLine({laneX(lane), rowMin.y}, {laneX(lane), rowMax.y},
                                      edge, stroke);
            }
            const float elbowX = laneX(depth - 1);
            const float midY = rowMin.y + kit::densityMetrics().padY +
                               ImGui::GetTextLineHeight() * 0.5f;
            drawList->AddLine({elbowX, rowMin.y},
                              {elbowX, treeRow.lastChild ? midY : rowMax.y}, edge,
                              stroke);
            drawList->AddLine({elbowX, midY}, {elbowX + indentStep * 0.45f, midY},
                              edge, stroke);
        }

        if (const std::string_view transcript = agentTranscript(agent.id); !transcript.empty()) {
            if (indent > 0.0f) ImGui::Indent(indent);
            kit::CardOptions options{"Transcript", nullptr, kit::Tone::Neutral, false};
            const bool body = kit::cardBegin("##agent-transcript", options);
            if (body) {
                ImGui::PushTextWrapPos(0.0f);
                ImGui::TextUnformatted(transcript.data(), transcript.data() + transcript.size());
                ImGui::PopTextWrapPos();
            }
            kit::cardEnd();
            if (indent > 0.0f) ImGui::Unindent(indent);
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
    if (!newSessionCwd.empty() &&
        iconActionButton(Action::NewSession, "New session", ButtonKind::Primary))
        dispatch("session.new", {{"cwd", newSessionCwd}});

    if (store_.sessions().empty()) {
        (void)kit::emptyState("No saved sessions", "New and recent sessions appear here.");
        return;
    }
    // rowBegin claims the whole content region, so a full-width row paints its
    // selection highlight onto the panel border. A padding-free child one
    // gutter narrower is the only per-row way to reserve that margin.
    const float listWidth = std::max(ui::metrics::U(16.0f),
                                     ImGui::GetContentRegionAvail().x -
                                         ui::metrics::px(8.0f));
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.0f, 0.0f));
    ImGui::BeginChild("##session-list", ImVec2(listWidth, 0.0f),
                      ImGuiChildFlags_AutoResizeY);
    ImGui::PopStyleVar();
    for (const DesktopSessionInfo& session : store_.sessions()) {
        ImGui::PushID(session.path.c_str());
        kit::RowStyle style;
        style.secondary = session.cwd.c_str();
        style.meta = session.pinned.value_or(false) ? "pinned" : nullptr;
        (void)kit::rowBegin("##session", style);
        const std::string title = session.title.value_or(sessionLabel(session.id));
        const float labelWidth = std::max(ui::metrics::px(24.0f),
                                          ImGui::GetContentRegionAvail().x -
                                              kit::densityMetrics().padX);
        ImGui::TextUnformatted(kit::elide(title, labelWidth).c_str());
        // No row in this panel is wide enough for a full id, so it hides here.
        if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", session.id.c_str());
        std::string& rename = sessionRenames_[session.path];
        if (rename.empty()) rename = title;
        ImGui::SetNextItemWidth(std::max(ui::metrics::U(16.0f),
                                        ImGui::GetContentRegionAvail().x -
                                            ui::metrics::U(17.0f)));
        inputTextString("##rename", rename);
        ImGui::SameLine();
        if (iconActionButton(Action::RenameSession, "Rename session",
                             ButtonKind::Secondary, !rename.empty() && rename != title,
                             "Edit the name first"))
            dispatch("session.rename", {{"path", session.path}, {"title", rename}});
        if (iconActionButton(Action::OpenSession, "Open session", ButtonKind::Secondary)) {
            setSessionPath(session.path);
            dispatch("session.select", {{"path", session.path}});
        }
        ImGui::SameLine();
        if (iconActionButton(Action::ForkSession, "Fork session", ButtonKind::Secondary))
            dispatch("session.fork", {{"path", session.path}});
        ImGui::SameLine();
        if (iconActionButton(Action::PinSession,
                             session.pinned.value_or(false) ? "Unpin session"
                                                            : "Pin session",
                             ButtonKind::Secondary))
            dispatch("session.pin", {{"path", session.path},
                                      {"pinned", !session.pinned.value_or(false)}});
        ImGui::SameLine();
        if (iconActionButton(Action::DeleteSession, "Delete session", ButtonKind::Danger))
            dispatch("session.delete", {{"path", session.path}});
        kit::rowEnd();
        ImGui::PopID();
    }
    ImGui::EndChild();
}

void CopilotView::drawDrawer() {
    ImGui::BeginChild("##copilot-drawer", ImVec2(0.0f, ui::metrics::U(42.0f)),
                      ImGuiChildFlags_Borders);
    switch (drawer_) {
    case Drawer::Agents: drawAgents(); break;
    case Drawer::Tasks: drawTasks(); break;
    case Drawer::Sessions: drawSessions(); break;
    case Drawer::None: break;
    }
    ImGui::EndChild();
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

void CopilotView::setImageBackend(icons::TextureBackend backend) {
    imageTextures_.emplace(std::move(backend));
}

// Context-capacity gauge: usage icon, slim bar, and an honest label. Tone
// follows the TUI thresholds (usageLevel): amber once compaction pressure
// begins, red near capacity, usageUnknown when the provider reported nothing
// — never a fake empty bar.
void CopilotView::drawUsageGauge() {
    const SessionSnapshot* snapshot = store_.session(sessionPath_);
    if (snapshot == nullptr || !snapshot->state) return;
    const ContextUsage usage = snapshot->state->contextUsage.value_or(ContextUsage{});
    const UsageLevel level = usageLevel(usage);
    const std::optional<double> fraction = usageFraction(usage);
    const std::string label = usageLabel(usage);

    const ui::Palette& p = ui::palette();
    const ImVec4 tone = level == UsageLevel::Err    ? p.usageErr
                        : level == UsageLevel::Warn ? p.usageWarn
                        : level == UsageLevel::Ok   ? p.usageOk
                                                    : p.usageUnknown;
    const float lineHeight = ImGui::GetTextLineHeight();
    const float spacing = ImGui::GetStyle().ItemSpacing.x;

    ImGui::PushID("##usage-gauge");
    if (icons::iconsLoaded()) {
        const ImVec2 iconPos = ImGui::GetCursorScreenPos();
        ImGui::Dummy(ImVec2(lineHeight, lineHeight));
        icons::drawIcon(ImGui::GetWindowDrawList(), "usage", iconPos, lineHeight);
        ImGui::SameLine(0.0f, kit::densityMetrics().headGap);
    }

    std::string tooltip = "Context usage: " + label;
    if (usage.tokens && usage.contextWindow && *usage.contextWindow > 0) {
        tooltip += "\n" + fmtTokens(*usage.tokens) + " of " +
                   fmtTokens(*usage.contextWindow) + " tokens";
    }
    tooltip += "\nAmber: compaction pressure. Red: near capacity.";

    const float labelWidth = ImGui::CalcTextSize(label.c_str()).x;
    const float available = ImGui::GetContentRegionAvail().x;
    const float barMinimum = ui::metrics::px(48.0f);
    if (available >= labelWidth + barMinimum + spacing) {
        // Draw-list convention: hit item + visual pair, cursor flows inline.
        const float barWidth = available - labelWidth - spacing;
        const float barHeight = ui::metrics::px(6.0f);
        const ImVec2 start = ImGui::GetCursorScreenPos();
        ImGui::InvisibleButton("##usage-bar", ImVec2(barWidth, lineHeight));
        if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", tooltip.c_str());
        ImDrawList* drawList = ImGui::GetWindowDrawList();
        const float top = start.y + (lineHeight - barHeight) * 0.5f;
        const float round = barHeight * 0.5f;
        drawList->AddRectFilled({start.x, top}, {start.x + barWidth, top + barHeight},
                                ui::toU32(p.usageTrack), round);
        if (fraction && *fraction > 0.0) {
            drawList->AddRectFilled(
                {start.x, top},
                {start.x + barWidth * static_cast<float>(*fraction), top + barHeight},
                ui::toU32(tone), round);
        }
        ImGui::SameLine(0.0f, spacing);
        ImGui::PushStyleColor(ImGuiCol_Text,
                              level == UsageLevel::Ok ? p.textDim : tone);
        ImGui::TextUnformatted(label.c_str());
        ImGui::PopStyleColor();
    } else {
        // Too narrow for a meaningful bar: tone-tinted label only, elided with
        // the full story in the tooltip — degraded, never clipped.
        ImGui::PushStyleColor(ImGuiCol_Text,
                              level == UsageLevel::Ok ? p.textDim : tone);
        ImGui::TextUnformatted(
            kit::elide(label, std::max(ui::metrics::px(24.0f), available)).c_str());
        ImGui::PopStyleColor();
    }
    if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", tooltip.c_str());
    ImGui::PopID();
}

// Real thumbnails for draft attachments. Pixels come from the bounded
// ImageTextureCache; when they are unavailable (no GL backend, undecodable
// payload) the attachment stays a typed mime chip with the reason in its
// tooltip. Click enlarges; the close-tab icon button removes.
void CopilotView::drawDraftImages(ComposerDraft& value) {
    if (value.images.empty()) return;
    const ui::Palette& p = ui::palette();
    const float thumbHeight = ui::metrics::U(14.0f);
    const float removeSide = ImGui::GetFrameHeight();
    std::optional<std::size_t> removeIndex;

    for (std::size_t index = 0; index < value.images.size(); ++index) {
        const ImageContent& image = value.images[index];
        ImGui::PushID(static_cast<int>(index));
        const ImageTexture texture =
            imageTextures_ ? imageTextures_->acquire(image) : ImageTexture{};

        float itemWidth;
        if (texture.valid) {
            const float aspect = texture.height > 0
                                     ? static_cast<float>(texture.width) /
                                           static_cast<float>(texture.height)
                                     : 1.0f;
            itemWidth = std::clamp(thumbHeight * aspect, thumbHeight * 0.5f,
                                   thumbHeight * 2.5f);
        } else {
            itemWidth = ImGui::CalcTextSize((image.mimeType + " · no preview").c_str()).x +
                        kit::densityMetrics().padX * 2.0f;
        }
        // Flow layout: wrap before the panel edge instead of clipping.
        if (index != 0 &&
            ImGui::GetContentRegionAvail().x >=
                itemWidth + removeSide + ImGui::GetStyle().ItemSpacing.x * 2.0f)
            ImGui::SameLine();

        if (texture.valid) {
            const ImVec2 start = ImGui::GetCursorScreenPos();
            ImGui::InvisibleButton("##thumb", ImVec2(itemWidth, thumbHeight));
            const bool hovered = ImGui::IsItemHovered();
            const bool clicked = ImGui::IsItemClicked();
            ImDrawList* drawList = ImGui::GetWindowDrawList();
            const float round = kit::densityMetrics().rowRound;
            const ImVec2 end(start.x + itemWidth, start.y + thumbHeight);
            drawList->AddRectFilled(start, end, ui::toU32(p.attachmentBg), round);
            drawList->AddImageRounded(texture.texture, start, end, ImVec2(0.0f, 0.0f),
                                      ImVec2(1.0f, 1.0f), IM_COL32_WHITE, round);
            const bool selected = lightboxImage_ && *lightboxImage_ == index;
            drawList->AddRect(start, end,
                              ui::toU32(hovered    ? p.attachmentHovered
                                        : selected ? p.attachmentSelected
                                                   : p.attachmentBorder),
                              round, 0, ui::metrics::stroke(hovered || selected ? 2.0f : 1.0f));
            if (hovered)
                ImGui::SetTooltip("%s · %dx%d\nClick to enlarge", image.mimeType.c_str(),
                                  texture.width, texture.height);
            if (clicked) {
                lightboxImage_ = index;
                lightboxOpened_ = false;
            }
        } else {
            const std::string label = image.mimeType + " · no preview";
            (void)kit::chip(label.c_str(), kit::Tone::Info);
            if (ImGui::IsItemHovered())
                ImGui::SetTooltip("%s", imageTextures_
                                            ? "Attachment did not decode as an image; "
                                              "it will still be sent as attached"
                                            : "Thumbnails need the GPU texture backend; "
                                              "the attachment will still be sent");
        }
        ImGui::SameLine();
        if (iconActionButton(Action::RemoveAttachment, "Remove attachment",
                             ButtonKind::Secondary))
            removeIndex = index;
        ImGui::PopID();
    }

    if (removeIndex) {
        if (lightboxImage_ && *lightboxImage_ >= *removeIndex) lightboxImage_.reset();
        value.images.erase(value.images.begin() +
                           static_cast<std::ptrdiff_t>(*removeIndex));
        if (!value.dirty()) notifyDraftDirty(sessionPath_, false);
    }
}

void CopilotView::drawLightbox(ComposerDraft& value) {
    if (!lightboxImage_) return;
    if (*lightboxImage_ >= value.images.size() || !imageTextures_) {
        lightboxImage_.reset();
        return;
    }
    const ImageContent& image = value.images[*lightboxImage_];
    const ImageTexture texture = imageTextures_->acquire(image);
    if (!texture.valid) {
        lightboxImage_.reset();
        return;
    }

    if (!lightboxOpened_) {
        ImGui::OpenPopup("##attachment-lightbox");
        lightboxOpened_ = true;
    }
    const ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(viewport->GetCenter(), ImGuiCond_Appearing,
                            ImVec2(0.5f, 0.5f));
    if (ImGui::BeginPopup("##attachment-lightbox")) {
        const ImVec2 bound(viewport->WorkSize.x * 0.8f, viewport->WorkSize.y * 0.8f);
        const float scale = std::min(
            1.0f, std::min(bound.x / static_cast<float>(texture.width),
                           bound.y / static_cast<float>(texture.height)));
        const ImVec2 shown(static_cast<float>(texture.width) * scale,
                           static_cast<float>(texture.height) * scale);
        ImGui::Image(texture.texture, shown);
        char caption[96];
        std::snprintf(caption, sizeof caption, "%s · %dx%d · Esc closes",
                      image.mimeType.c_str(), texture.width, texture.height);
        kit::dimText(caption);
        ImGui::EndPopup();
    } else {
        // Escape or an outside click dismissed the popup.
        lightboxImage_.reset();
        lightboxOpened_ = false;
    }
}

void CopilotView::drawComposer() {
    ComposerDraft& value = draft();
    const float glyphWidth = std::max(1.0f, ImGui::CalcTextSize("M").x);
    const std::size_t columns = static_cast<std::size_t>(
        std::max(8.0f, std::floor(ImGui::GetContentRegionAvail().x / glyphWidth) - 2.0f));
    value.text.setWrapColumns(columns);
    if (value.editBuffer != value.text.displayText()) value.editBuffer = value.text.displayText();
    value.editBuffer.reserve(std::max<std::size_t>(value.editBuffer.size() + 1024, 4096));

    drawDraftImages(value);

    const bool wasDirty = value.dirty();
    ComposerCallbackContext context{this, &value, &value.editBuffer};
    composerSubmitRequested_ = false;
    const ImGuiInputTextFlags flags = ImGuiInputTextFlags_CallbackResize |
                                      ImGuiInputTextFlags_CallbackCharFilter |
                                      ImGuiInputTextFlags_CallbackEdit |
                                      ImGuiInputTextFlags_CallbackAlways |
                                      ImGuiInputTextFlags_AllowTabInput;
    const float composerHeight = ImGui::GetTextLineHeightWithSpacing() *
                                 static_cast<float>(ui::metrics::kComposerMaxLines);
    const bool changed = ImGui::InputTextMultiline(
        "##composer", value.editBuffer.data(), value.editBuffer.capacity() + 1,
        ImVec2(-1.0f, composerHeight), flags, composerInputCallback, &context);
    value.editBuffer.resize(std::strlen(value.editBuffer.c_str()));
    if (changed) {
        value.text.applyEdited(value.editBuffer);
        value.editBuffer = value.text.displayText();
        if (wasDirty != value.dirty()) notifyDraftDirty(sessionPath_, value.dirty());
    }

    const bool streaming = store_.session(sessionPath_) && store_.session(sessionPath_)->state &&
                           store_.session(sessionPath_)->state->isStreaming;
    if (streaming) {
        if (iconActionButton(Action::Stop, "Stop the running turn", ButtonKind::Danger))
            stop();
        ImGui::SameLine();
    }
    if (iconActionButton(Action::Send, "Send message (Enter)", ButtonKind::Primary,
                         value.dirty(), "Type a message or attach an image first"))
        submit();
    // Measured twice: beside Send, and on the line the hint would get to
    // itself. Spending a whole line is only worth it when the wider measurement
    // buys a more informative hint, so nothing is ever truncated and no space
    // is wasted at the widths where the hint already fits the button row.
    const float ownLineWidth = ImGui::GetContentRegionAvail().x;
    ImGui::SameLine();
    const int inlineTier = fittingHint(ImGui::GetContentRegionAvail().x);
    const int ownLineTier = fittingHint(ownLineWidth);
    const bool ownLine = ownLineTier < inlineTier;
    if (ownLine) ImGui::NewLine();
    // Wrapping is the last resort: a font that measures wider than the tier
    // budget must push text down, never under the panel edge.
    ImGui::PushTextWrapPos(0.0f);
    kit::dimText(kHintTiers[ownLine ? ownLineTier : inlineTier]);
    ImGui::PopTextWrapPos();
    if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", kHintTooltip);
    if (composerSubmitRequested_ && value.dirty()) submit();
}

void CopilotView::draw(ImVec2 size) {
    if (sessionPath_.empty() && store_.activeSessionPath())
        setSessionPath(*store_.activeSessionPath());
    refreshProjection();

    ImGui::PushID(this);
    ImGui::BeginChild("##copilot", size, ImGuiChildFlags_None, ImGuiWindowFlags_NoScrollbar);

    const bool agents = drawer_ == Drawer::Agents;
    const bool tasks = drawer_ == Drawer::Tasks;
    const bool sessions = drawer_ == Drawer::Sessions;
    if (kit::chip("Agents", agents ? kit::Tone::Accent : kit::Tone::Neutral))
        drawer_ = agents ? Drawer::None : Drawer::Agents;
    ImGui::SameLine();
    if (kit::chip("Tasks", tasks ? kit::Tone::Accent : kit::Tone::Neutral))
        drawer_ = tasks ? Drawer::None : Drawer::Tasks;
    ImGui::SameLine();
    if (kit::chip("Sessions", sessions ? kit::Tone::Accent : kit::Tone::Neutral))
        drawer_ = sessions ? Drawer::None : Drawer::Sessions;
    if (!projection_.activeTools.empty()) {
        ImGui::SameLine();
        kit::inlineStatus(kit::Status::Running,
                          (std::to_string(projection_.activeTools.size()) + " active").c_str());
    }

    if (drawer_ != Drawer::None) drawDrawer();
    const float requestReserve = projection_.uiRequest ? ui::metrics::U(28.0f) : 0.0f;
    // Reserve the composer's real chrome: attachment thumbnails, the context
    // gauge, input box, button row, and the key hint, which takes its own line
    // whenever it cannot fit beside Send. The ##copilot child carries no
    // scrollbar, so under-reserving clips the hint instead of scrolling to it.
    const ComposerDraft* activeDraft = drafts_.find(sessionPath_);
    float attachmentsReserve = 0.0f;
    if (activeDraft != nullptr && !activeDraft->images.empty()) {
        // Worst-case flow estimate: widest thumbnail (or fallback chip) plus
        // its remove button per item. Overestimating shrinks the transcript a
        // little; underestimating clips the composer's key hint.
        const float itemWorstWidth = std::max(ui::metrics::U(14.0f) * 2.5f,
                                              ui::metrics::px(240.0f)) +
                                     ImGui::GetFrameHeight() +
                                     ImGui::GetStyle().ItemSpacing.x * 2.0f;
        const float rowWidth = std::max(itemWorstWidth, ImGui::GetContentRegionAvail().x);
        const std::size_t perRow = std::max<std::size_t>(
            1, static_cast<std::size_t>(rowWidth / itemWorstWidth));
        const std::size_t rows =
            (activeDraft->images.size() + perRow - 1) / perRow;
        attachmentsReserve =
            static_cast<float>(rows) *
            (ui::metrics::U(14.0f) + ImGui::GetStyle().ItemSpacing.y);
    }
    const SessionSnapshot* snapshot = store_.session(sessionPath_);
    const float gaugeReserve = snapshot != nullptr && snapshot->state
                                   ? ImGui::GetTextLineHeightWithSpacing()
                                   : 0.0f;
    const float composerReserve =
        ImGui::GetTextLineHeightWithSpacing() *
            static_cast<float>(ui::metrics::kComposerMaxLines + 1) +
        ImGui::GetFrameHeight() + ImGui::GetStyle().ItemSpacing.y * 2.0f +
        requestReserve + attachmentsReserve + gaugeReserve;
    drawTranscript(std::max(ui::metrics::U(20.0f),
                            ImGui::GetContentRegionAvail().y - composerReserve));
    drawUsageGauge();
    drawUiRequest();
    drawComposer();
    drawLightbox(draft());
    ImGui::EndChild();
    ImGui::PopID();
}

}  // namespace chud::copilot
