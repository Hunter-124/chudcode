#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "protocol/wire_types.h"

namespace chud {
class DesktopClient;
class DesktopStore;
}

namespace chud::editor {
class EditorPanel;
}

namespace chud::workspace {

struct FileMotion {
    FileChangeKind kind = FileChangeKind::Modified;
    ChangeOrigin origin = ChangeOrigin::External;
    float remainingSeconds = 0.0F;
    float durationSeconds = 0.0F;
};

// Owns workspace navigation state only. Every file-system operation is sent to
// the Bun desktop service through DesktopClient; this class never reads a path.
class WorkspaceView {
public:
    WorkspaceView(DesktopClient& client, DesktopStore& store, editor::EditorPanel& editor);
    ~WorkspaceView();
    WorkspaceView(const WorkspaceView&) = delete;
    WorkspaceView& operator=(const WorkspaceView&) = delete;
    WorkspaceView(WorkspaceView&&) noexcept;
    WorkspaceView& operator=(WorkspaceView&&) noexcept;

    // WorkspaceView caches navigation state per project. EditorPanel owns one
    // shared cross-project tab/session set, which project switching preserves.
    void openProject(std::string rootPath);
    void requestOpenFolder();
    void refreshRecent();
    void setWorkspace(WorkspaceDescriptor workspace);
    [[nodiscard]] const std::string& workspaceId() const noexcept;
    [[nodiscard]] const std::string& rootPath() const noexcept;
    [[nodiscard]] const WorkspaceDescriptor* currentWorkspace() const noexcept;
    [[nodiscard]] const std::vector<RecentProject>& recentProjects() const noexcept;
    [[nodiscard]] std::size_t projectStateCount() const noexcept;

    // Lazy tree state and protocol-backed file operations. An empty parent uri
    // means the workspace root.
    void refreshTree(std::optional<DocumentUri> parentUri = std::nullopt);
    void setExpanded(std::string uri, bool expanded);
    void toggleExpanded(std::string uri);
    [[nodiscard]] bool isExpanded(std::string_view uri) const noexcept;
    void select(std::string uri);
    [[nodiscard]] std::string_view selectedUri() const noexcept;
    [[nodiscard]] const std::vector<WorkspaceEntry>& entries(std::string_view parentUri = {}) const noexcept;

    void create(std::string uri, bool directory = false);
    void rename(std::string from, std::string to);
    void copy(std::string from, std::string to, bool recursive = false);
    void remove(std::string uri, DeleteMode mode = DeleteMode::Trash);
    void reveal(std::string uri);

    [[nodiscard]] bool isIgnored(std::string_view uri) const noexcept;
    [[nodiscard]] std::string statusBadge(std::string_view uri) const;
    void search(std::string text, SearchKind kind = SearchKind::Files,
                std::int64_t maxResults = 100, bool includeIgnored = false);
    void quickOpen(std::string text = {});
    [[nodiscard]] const std::vector<SearchResult>& searchResults() const noexcept;
    [[nodiscard]] SearchKind searchKind() const noexcept;
    [[nodiscard]] bool searchPending() const noexcept;
    [[nodiscard]] bool openSource(std::string uri);

    // Feed workspace-change events directly, or call syncFromStore() after the
    // client drain. Agent/external changes notify open editors and use the
    // shared motion tokens for tree-row feedback.
    void applyChanges(std::string_view workspaceId, const std::vector<FileChange>& changes);
    void syncFromStore();
    void advanceAnimations(float deltaSeconds);
    [[nodiscard]] std::optional<FileMotion> motion(std::string_view uri) const noexcept;

    [[nodiscard]] const std::string& lastError() const noexcept;
    void clearError();

    // draw() always includes the prominent project switcher, quick-open/search,
    // lazy tree, keyboard navigation, and context menus. drawProjectSwitcher()
    // is exposed for shells that place it in a global toolbar instead.
    void draw(const char* id, float width = 0.0F, float height = 0.0F);
    void drawProjectSwitcher();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace chud::workspace

namespace chud {
using WorkspaceView = workspace::WorkspaceView;
}
