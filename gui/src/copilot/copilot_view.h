#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include <imgui.h>

#include "copilot/image_textures.h"
#include "protocol/desktop_store.h"

namespace chud::session_graph {
struct SessionDag;
}  // namespace chud::session_graph

namespace chud::copilot {

// Human label for a session id shaped "<ISO-8601 UTC>_<uuid>": the leading
// timestamp as a local date/time, or a short id prefix when it does not parse.
// A titleless session would otherwise render an unreadable raw id.
[[nodiscard]] std::string sessionLabel(const std::string& id);

// Local date/time for a session id, or nullopt when `id` is not one. A caller
// holding only a tab title needs the distinction: the title is either a
// human-chosen name, shown verbatim, or the server's fallback to the raw id.
[[nodiscard]] std::optional<std::string> sessionStamp(const std::string& id);

// The primary copilot actions, each backed by a named atlas icon
// (docs/UI_FOUNDATION.md §6 inventory). actionIconName() is total: every
// action maps to a member of chud::icons::kIconNames, and the tooltip string
// is the action's accessible label — icon buttons are never unlabeled.
enum class Action {
    Send,
    Stop,
    AttachImage,
    RemoveAttachment,
    NewSession,
    OpenSession,
    RenameSession,
    ForkSession,
    PinSession,
    DeleteSession,
    AgentMessage,
    AgentTranscript,
    AgentRevive,
    AgentKill,
};

[[nodiscard]] const char* actionIconName(Action action) noexcept;

// Context-capacity tone tiers with the TUI status line's semantics
// (packages/coding-agent/src/modes/components/status-line/context-thresholds.ts):
// amber from min(ui::shared::kUsageThresholds.warning, 150k tokens) — where
// compaction pressure begins — and red from min(kUsageThresholds.critical,
// 500k tokens) — near capacity. The TUI's intermediate 70% tier folds into
// Warn; the GUI palette carries usage ok/warn/err/unknown roles.
enum class UsageLevel { Unknown, Ok, Warn, Err };

[[nodiscard]] UsageLevel usageLevel(const ContextUsage& usage) noexcept;
// Used fraction of the window in [0,1] (clamped), or nullopt when unknowable.
[[nodiscard]] std::optional<double> usageFraction(const ContextUsage& usage) noexcept;
// Honest label: "42.0% of 200.0k" with a known window, "12.3k tokens /
// window unknown" without one, "context usage unknown" with nothing. Never
// renders a fake 0%.
[[nodiscard]] std::string usageLabel(const ContextUsage& usage);

// One row of the agent tree: agents grouped under their parentId in DFS
// order. `orphan` and `recoverable` carry the SessionDag semantics
// (graph/session_dag.h): an orphan's parent id names no live agent; parked
// and failed agents are recoverable. `trunkMask` bit d says an ancestor at
// depth d still has siblings below (draw a continuation line); `lastChild`
// picks the elbow versus tee connector at this row's own depth.
struct AgentTreeRow {
    std::string agentId;
    std::string label;
    std::string detail;
    int depth = 0;
    bool orphan = false;
    bool recoverable = false;
    bool lastChild = false;
    std::uint32_t trunkMask = 0;

    bool operator==(const AgentTreeRow&) const = default;
};

// Flattens the DAG's agent nodes into indented rows. Orphans hang off the
// session root (exactly as buildSessionDag parents them) and keep their
// orphan flag; parent cycles are broken by the visited guard rather than
// looping.
[[nodiscard]] std::vector<AgentTreeRow> agentHierarchy(
    const session_graph::SessionDag& dag);

enum class TranscriptKind {
    User,
    Assistant,
    Thinking,
    Tool,
    ToolResult,
    Agent,
    Task,
    UiRequest,
    Status,
    System,
};

struct TranscriptRow {
    std::string id;
    TranscriptKind kind = TranscriptKind::System;
    std::string title;
    std::string text;
    std::string meta;
    Json detail;
    std::size_t order = 0;
    bool live = false;
    bool failed = false;

    bool operator==(const TranscriptRow&) const = default;
};

struct ActiveTool {
    std::string id;
    std::string name;
    std::string intent;
    Json arguments;

    bool operator==(const ActiveTool&) const = default;
};

struct TaskItem {
    std::string id;
    std::string title;
    std::string state;
    std::optional<std::string> parentId;
    std::string phase;

    bool operator==(const TaskItem&) const = default;
};

struct TranscriptProjection {
    std::vector<TranscriptRow> rows;
    std::vector<ActiveTool> activeTools;
    std::vector<TaskItem> tasks;
    std::optional<UiRequest> uiRequest;

    [[nodiscard]] static TranscriptProjection from(const SessionSnapshot& snapshot);
};

// The display buffer has exactly the same byte length as canonicalText(). Soft
// wraps replace ASCII spaces with '\n'; hard newlines are recorded out of band.
// This gives ImGui stable byte offsets for mouse selection and editing while
// copy/submit can restore soft breaks without touching authored line breaks.
class SoftWrappedText {
public:
    explicit SoftWrappedText(std::string text = {}, std::size_t wrapColumns = 0);

    void setCanonical(std::string text);
    void setWrapColumns(std::size_t columns);
    // Called from ImGui's CallbackEdit while the buffer still contains the
    // user's edit and before visual wrapping rewrites any spaces/newlines.
    void recordEdit(std::string_view editedDisplay, std::size_t cursor);
    void applyEdited(std::string editedDisplay);

    [[nodiscard]] const std::string& displayText() const noexcept { return displayText_; }
    [[nodiscard]] std::string canonicalText() const;
    [[nodiscard]] std::string copyRange(std::size_t first, std::size_t last) const;
    [[nodiscard]] const std::vector<std::size_t>& hardBreakOffsets() const noexcept {
        return hardBreakOffsets_;
    }
    [[nodiscard]] const std::vector<std::size_t>& softBreakOffsets() const noexcept {
        return softBreakOffsets_;
    }
    [[nodiscard]] std::size_t wrapColumns() const noexcept { return wrapColumns_; }
    [[nodiscard]] bool empty() const noexcept { return displayText_.empty(); }

private:
    struct BreakSnapshot {
        std::string display;
        std::vector<std::size_t> hardBreaks;
    };

    void rememberSnapshot();
    void reseedBreaks(std::string_view display);
    void rewrap(std::string canonical);
    [[nodiscard]] bool isHardBreak(std::size_t offset) const noexcept;

    std::string displayText_;
    std::vector<std::size_t> hardBreakOffsets_;
    std::vector<std::size_t> softBreakOffsets_;
    std::vector<BreakSnapshot> breakHistory_;
    std::size_t editLength_ = 0;
    std::size_t wrapColumns_ = 0;
    bool editPending_ = false;
};

struct ComposerDraft {
    SoftWrappedText text;
    std::vector<ImageContent> images;
    std::string editBuffer;

    [[nodiscard]] bool dirty() const noexcept { return !text.empty() || !images.empty(); }
    void setText(std::string value, std::size_t wrapColumns = 0);
    void clear();
};

struct TransparentStringHash {
    using is_transparent = void;
    [[nodiscard]] std::size_t operator()(std::string_view value) const noexcept {
        return std::hash<std::string_view>{}(value);
    }
    [[nodiscard]] std::size_t operator()(const std::string& value) const noexcept {
        return (*this)(std::string_view(value));
    }
};

class DraftStore {
public:
    [[nodiscard]] ComposerDraft& forSession(std::string_view sessionPath);
    [[nodiscard]] const ComposerDraft* find(std::string_view sessionPath) const noexcept;
    void erase(std::string_view sessionPath);
    [[nodiscard]] bool dirty(std::string_view sessionPath) const noexcept;

private:
    std::unordered_map<std::string, ComposerDraft, TransparentStringHash,
                       std::equal_to<>>
        drafts_;
};

class ScrollLock {
public:
    void observe(float scrollY, float scrollMaxY, bool userScrolled);
    void release() noexcept { locked_ = false; }
    void lock() noexcept { locked_ = true; }
    [[nodiscard]] bool locked() const noexcept { return locked_; }
    [[nodiscard]] bool shouldFollowAppend() const noexcept { return locked_; }

private:
    bool locked_ = true;
};

enum class CloseBlock { None, Running, Draft, RunningAndDraft };

struct CloseGuard {
    CloseBlock block = CloseBlock::None;
    std::string reason;

    [[nodiscard]] bool canClose() const noexcept { return block == CloseBlock::None; }
    [[nodiscard]] bool needsConfirmation() const noexcept { return block != CloseBlock::None; }
};

struct SessionTabView {
    std::string path;
    std::string title;
    bool active = false;
    bool running = false;
    std::int64_t unread = 0;
    bool draftDirty = false;
    CloseGuard closeGuard;
};

struct CopilotActions {
    using Response = std::function<void(const ResponseFrame&)>;
    using Request = std::function<void(std::string method, Json params, Response response)>;
    Request request;
};

class CopilotView {
public:
    explicit CopilotView(DesktopStore& store, CopilotActions actions = {});

    void setSessionPath(std::string_view sessionPath);
    [[nodiscard]] std::string_view sessionPath() const noexcept { return sessionPath_; }
    [[nodiscard]] ComposerDraft& draft();
    [[nodiscard]] ComposerDraft& draft(std::string_view sessionPath);
    [[nodiscard]] const DraftStore& drafts() const noexcept { return drafts_; }

    // The session DAG built by the app for the Sessions activity; borrowed,
    // not owned. Supplies grouping/orphan/recoverable state for the agents
    // drawer. May be null (headless, or before the first sync).
    void setSessionDag(const session_graph::SessionDag* dag) noexcept { sessionDag_ = dag; }
    // Enables real draft-image thumbnails. Without a backend (headless tests)
    // attachments render as typed mime chips — pixels are never faked.
    void setImageBackend(icons::TextureBackend backend);
    [[nodiscard]] ImageTextureCache* imageTextures() noexcept {
        return imageTextures_ ? &*imageTextures_ : nullptr;
    }

    [[nodiscard]] std::span<const SessionTabView> sessionTabs() const;
    [[nodiscard]] CloseGuard closeGuard(std::string_view sessionPath) const;
    bool switchSession(std::string_view sessionPath);
    bool closeSession(std::string_view sessionPath, bool force = false);

    bool submit();
    bool stop();
    bool respondToUi(std::string value);
    bool commandAgent(std::string_view agentId, std::string_view command,
                      std::string text = {});
    bool requestAgentTranscript(std::string_view agentId, std::int64_t fromByte = 0);
    void attachImage(ImageContent image);

    [[nodiscard]] const TranscriptProjection& projection() const noexcept { return projection_; }
    [[nodiscard]] const ScrollLock& scrollLock() const noexcept { return scrollLock_; }
    [[nodiscard]] std::string_view agentTranscript(std::string_view agentId) const noexcept;

    // Draws transcript/drawers, pending ask/permission form, and the native
    // multiline composer. The app consumes sessionTabs() for its always-visible
    // global strip; no app-side input routing state needs synchronization.
    void draw(ImVec2 size = ImVec2(0.0f, 0.0f));

private:
    enum class Drawer { None, Agents, Tasks, Sessions };
    struct ProjectionStamp {
        const SessionSnapshot* source = nullptr;
        std::size_t entryCount = 0;
        std::string lastEntryId;
        std::string agentEventType;
        std::size_t agentEventHash = 0;
        bool hasState = false;
        bool streaming = false;
        bool aborting = false;
        std::int64_t queued = 0;
        std::optional<std::int64_t> uiRequestId;
        std::size_t uiRequestHash = 0;

        bool operator==(const ProjectionStamp&) const = default;
    };


    bool dispatch(std::string method, Json params, CopilotActions::Response response = {});
    void refreshProjection();
    static int composerInputCallback(ImGuiInputTextCallbackData* data);
    void drawTranscript(float height);
    void drawRow(const TranscriptRow& row);
    void drawDrawer();
    void drawAgents();
    void drawTasks();
    void drawSessions();
    void drawUiRequest();
    void drawUsageGauge();
    void drawDraftImages(ComposerDraft& draft);
    void drawLightbox(ComposerDraft& draft);
    void drawComposer();
    void notifyDraftDirty(std::string_view path, bool dirty);

    DesktopStore& store_;
    CopilotActions actions_;
    std::string sessionPath_;
    DraftStore drafts_;
    mutable std::vector<SessionTabView> tabProjection_;
    ProjectionStamp projectionStamp_;
    TranscriptProjection projection_;
    ScrollLock scrollLock_;
    Drawer drawer_ = Drawer::None;
    std::unordered_map<std::string, std::string, TransparentStringHash, std::equal_to<>>
        agentTranscripts_;
    std::unordered_map<std::string, std::string, TransparentStringHash, std::equal_to<>>
        agentMessages_;
    std::unordered_map<std::string, std::string, TransparentStringHash, std::equal_to<>>
        sessionRenames_;
    const session_graph::SessionDag* sessionDag_ = nullptr;
    std::optional<ImageTextureCache> imageTextures_;
    std::optional<std::size_t> lightboxImage_;
    bool lightboxOpened_ = false;
    std::string uiResponse_;
    std::size_t composerSelectionFirst_ = 0;
    std::size_t composerSelectionLast_ = 0;
    bool composerSubmitRequested_ = false;
};

}  // namespace chud::copilot
