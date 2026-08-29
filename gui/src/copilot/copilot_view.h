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

#include "protocol/desktop_store.h"

namespace chud::copilot {

// Human label for a session id shaped "<ISO-8601 UTC>_<uuid>": the leading
// timestamp as a local date/time, or a short id prefix when it does not parse.
// A titleless session would otherwise render an unreadable raw id.
[[nodiscard]] std::string sessionLabel(const std::string& id);

// Local date/time for a session id, or nullopt when `id` is not one. A caller
// holding only a tab title needs the distinction: the title is either a
// human-chosen name, shown verbatim, or the server's fallback to the raw id.
[[nodiscard]] std::optional<std::string> sessionStamp(const std::string& id);

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
    std::string uiResponse_;
    std::size_t composerSelectionFirst_ = 0;
    std::size_t composerSelectionLast_ = 0;
    bool composerSubmitRequested_ = false;
};

}  // namespace chud::copilot
