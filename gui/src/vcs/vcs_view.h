#pragma once

#include <array>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <imgui.h>

#include "graph/graph_view.h"
#include "protocol/desktop_client.h"
#include "protocol/wire_types.h"
#include "vcs/diff_model.h"
class TextDiff;


namespace chud::vcs {

enum class StatusGroupKind : std::uint8_t { Conflicts, Staged, Changes, Untracked };

struct StatusGroup {
    StatusGroupKind kind = StatusGroupKind::Changes;
    std::vector<GitFileState> files;
    friend bool operator==(const StatusGroup&, const StatusGroup&) = default;
};

[[nodiscard]] std::vector<StatusGroup> groupFiles(const std::vector<GitFileState>& files);
[[nodiscard]] std::string_view statusGroupLabel(StatusGroupKind kind) noexcept;

struct VcsRequest {
    VcsRequest() = default;
    VcsRequest(std::string methodValue, Json paramsValue, bool destructiveValue = false,
               std::string confirmationValue = {})
        : method(std::move(methodValue)), params(std::move(paramsValue)),
          destructive(destructiveValue), confirmation(std::move(confirmationValue)) {}
    std::string method;
    Json params = Json::object();
    bool destructive = false;
    std::string confirmation;
    friend bool operator==(const VcsRequest&, const VcsRequest&) = default;
};

class VcsRequestFactory {
public:
    explicit VcsRequestFactory(std::string workspaceId) : workspaceId_(std::move(workspaceId)) {}

    [[nodiscard]] VcsRequest snapshot() const;
    [[nodiscard]] VcsRequest diff(std::optional<std::string> path = std::nullopt,
                                  std::optional<bool> staged = std::nullopt) const;
    [[nodiscard]] VcsRequest stage(const std::vector<std::string>& paths) const;
    [[nodiscard]] VcsRequest unstage(const std::vector<std::string>& paths) const;
    [[nodiscard]] VcsRequest commit(std::string message) const;
    [[nodiscard]] VcsRequest branches() const;
    [[nodiscard]] VcsRequest createBranch(std::string name,
                                          std::optional<std::string> startPoint = std::nullopt,
                                          bool checkout = true) const;
    [[nodiscard]] VcsRequest checkout(std::string ref, bool hasLocalChanges) const;
    [[nodiscard]] VcsRequest fetch(std::optional<std::string> remote = std::nullopt) const;
    [[nodiscard]] VcsRequest pull(std::optional<std::string> remote = std::nullopt,
                                  std::optional<std::string> branch = std::nullopt) const;
    [[nodiscard]] VcsRequest push(std::optional<std::string> remote = std::nullopt,
                                  std::optional<std::string> branch = std::nullopt,
                                  bool setUpstream = false) const;
    [[nodiscard]] VcsRequest remotes() const;
    [[nodiscard]] VcsRequest historyGraph() const;
    [[nodiscard]] VcsRequest hunk(std::string path, std::string hunkId,
                                  HunkAction action) const;

private:
    [[nodiscard]] Json workspaceParams() const;
    std::string workspaceId_;
};

struct PendingConfirmation {
    VcsRequest request;
    std::string title;
    friend bool operator==(const PendingConfirmation&, const PendingConfirmation&) = default;
};

class VcsView {
public:
    using ResponseCallback = std::function<void(const ResponseFrame&)>;
    using SubmitRequest = std::function<void(const VcsRequest&, ResponseCallback)>;
    using OpenGitGraph = std::function<void()>;

    // The lambda keeps graph ownership in the application: VcsView switches the
    // already-shared engine to Git rather than constructing a second graph scene.
    VcsView(DesktopClient& client, GraphView& graph)
        : VcsView(
              [&client](const VcsRequest& request, ResponseCallback callback) {
                  client.request(request.method, request.params, std::move(callback));
              },
              [&graph] { graph.setKind(GraphKind::Git); }) {}
    explicit VcsView(SubmitRequest submit = {}, OpenGitGraph openGitGraph = {});
    ~VcsView();
    VcsView(const VcsView&) = delete;
    VcsView& operator=(const VcsView&) = delete;

    void setWorkspace(std::string workspaceId);
    [[nodiscard]] const std::string& workspace() const noexcept { return workspaceId_; }
    void sync(const GitSnapshot& snapshot);
    void sync(const std::optional<GitSnapshot>& snapshot);

    [[nodiscard]] const std::optional<GitSnapshot>& snapshot() const noexcept { return snapshot_; }
    [[nodiscard]] const std::vector<StatusGroup>& groups() const noexcept { return groups_; }
    [[nodiscard]] const std::vector<GitBranch>& branches() const noexcept { return branches_; }
    [[nodiscard]] const std::vector<GitRemote>& remotes() const noexcept { return remotes_; }
    [[nodiscard]] const DiffDocument& diff() const noexcept { return diff_; }
    [[nodiscard]] const DiffAnimator& animator() const noexcept { return animator_; }
    [[nodiscard]] const std::optional<std::string>& error() const noexcept { return error_; }
    [[nodiscard]] const std::optional<PendingConfirmation>& pendingConfirmation() const noexcept {
        return confirmation_;
    }
    [[nodiscard]] bool busy() const noexcept { return !busyMethod_.empty(); }

    void refresh();
    void requestDiff(std::optional<std::string> path, bool staged);
    void stageFiles(const std::vector<std::string>& paths);
    void unstageFiles(const std::vector<std::string>& paths);
    void stageAll();
    void unstageAll();
    void commit(std::string message);
    void refreshBranches();
    void createBranch(std::string name, std::optional<std::string> startPoint = std::nullopt,
                      bool checkout = true);
    void checkout(std::string ref);
    void fetch(std::optional<std::string> remote = std::nullopt);
    void pull(std::optional<std::string> remote = std::nullopt,
              std::optional<std::string> branch = std::nullopt);
    void push(std::optional<std::string> remote = std::nullopt,
              std::optional<std::string> branch = std::nullopt, bool setUpstream = false);
    void refreshRemotes();
    void openHistory();
    bool actOnHunk(const DiffFile& file, const DiffHunk& hunk, HunkAction action);

    void confirmPending(bool accepted);
    void clearError() noexcept { error_.reset(); }
    void acceptDiff(std::string_view unified);
    void acceptBranches(std::vector<GitBranch> branches);
    void acceptRemotes(std::vector<GitRemote> remotes);
    void advanceAnimations(float deltaSeconds);

    // Requires the current ImGui context and the constructing/GL thread.
    void draw(const char* id, ImVec2 size = ImVec2(0.0F, 0.0F));

private:
    void dispatch(VcsRequest request, bool bypassConfirmation = false);
    void dispatchNow(VcsRequest request);
    void handleResponse(const VcsRequest& request, const ResponseFrame& response);
    [[nodiscard]] bool hasLocalChanges() const noexcept;
    [[nodiscard]] std::vector<std::string> pathsFor(StatusGroupKind kind) const;
    void drawToolbar();
    void drawCommit();
    void drawGroups(float height);
    void drawBranchesAndRemotes();
    void drawDiff(float height);
    void drawConfirmation();

    SubmitRequest submit_;
    OpenGitGraph openGitGraph_;
    std::string workspaceId_;
    std::optional<GitSnapshot> snapshot_;
    std::vector<StatusGroup> groups_;
    std::vector<GitBranch> branches_;
    std::vector<GitRemote> remotes_;
    DiffDocument diff_;
    DiffAnimator animator_;
    std::unique_ptr<TextDiff> textDiff_;
    std::optional<std::string> selectedPath_;
    bool selectedStaged_ = false;
    std::optional<std::string> error_;
    std::optional<PendingConfirmation> confirmation_;
    std::string busyMethod_;
    std::array<char, 2048> commitBuffer_{};
    std::array<char, 256> branchBuffer_{};
    std::shared_ptr<bool> alive_;
};

} // namespace chud::vcs
