#include "vcs/vcs_view.h"
#include <TextDiff.h>

// InputTextEx is the documented escape hatch for a multi-line input that also
// renders a placeholder hint; the public InputTextWithHint rejects Multiline.
#include <imgui_internal.h>

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <unordered_set>
#include <utility>

#include "protocol/json_codec.h"
#include "theme/anim.h"
#include "theme/theme.h"
#include "widgets/kit.h"

namespace chud::vcs {
namespace {

bool nonEmptyStatus(std::string_view status) {
    return !status.empty() && status != " " && status != "." && status != "??";
}

bool isConflict(const GitFileState& file) {
    const std::string code = file.staged + file.unstaged;
    return code == "DD" || code == "AU" || code == "UD" || code == "UA" ||
           code == "DU" || code == "AA" || code == "UU" || file.staged == "U" ||
           file.unstaged == "U";
}

std::vector<std::string> uniquePaths(const std::vector<std::string>& input) {
    std::vector<std::string> result;
    std::unordered_set<std::string> seen;
    result.reserve(input.size());
    for (const std::string& path : input) {
        if (seen.insert(path).second) result.push_back(path);
    }
    return result;
}

std::string_view actionText(HunkAction action) {
    switch (action) {
    case HunkAction::Stage: return "stage";
    case HunkAction::Unstage: return "unstage";
    case HunkAction::Revert: return "revert";
    }
    return "stage";
}

GitBranch parseBranch(const Json& value) {
    GitBranch branch;
    branch.name = value.at("name").get<std::string>();
    branch.current = value.at("current").get<bool>();
    branch.remote = value.at("remote").get<bool>();
    if (value.contains("upstream") && !value.at("upstream").is_null()) {
        branch.upstream = value.at("upstream").get<std::string>();
    }
    if (value.contains("ahead") && !value.at("ahead").is_null()) {
        branch.ahead = value.at("ahead").get<std::int64_t>();
    }
    if (value.contains("behind") && !value.at("behind").is_null()) {
        branch.behind = value.at("behind").get<std::int64_t>();
    }
    return branch;
}

GitRemote parseRemote(const Json& value) {
    return {value.at("name").get<std::string>(), value.at("fetchUrl").get<std::string>(),
            value.at("pushUrl").get<std::string>()};
}

kit::Tone groupTone(StatusGroupKind kind) {
    switch (kind) {
    case StatusGroupKind::Conflicts: return kit::Tone::Err;
    case StatusGroupKind::Staged: return kit::Tone::Ok;
    case StatusGroupKind::Changes: return kit::Tone::Warn;
    case StatusGroupKind::Untracked: return kit::Tone::Info;
    }
    return kit::Tone::Neutral;
}

const char* statusLabel(const GitFileState& file, StatusGroupKind kind) {
    if (kind == StatusGroupKind::Conflicts) return "!";
    if (kind == StatusGroupKind::Untracked) return "U";
    if (kind == StatusGroupKind::Staged) return file.staged.c_str();
    return file.unstaged.c_str();
}
std::pair<std::string, std::string> diffSides(const DiffDocument& document) {
    std::string left;
    std::string right;
    const auto appendBoth = [&](std::string_view text) {
        left.append(text).push_back('\n');
        right.append(text).push_back('\n');
    };
    for (const DiffFile& file : document.files) {
        appendBoth(std::string("file: ") + std::string(file.displayPath()));
        for (const DiffHunk& hunk : file.hunks) {
            appendBoth(hunk.header);
            for (const DiffLine& line : hunk.lines) {
                switch (line.kind) {
                case DiffLineKind::Context:
                case DiffLineKind::NoNewline:
                    appendBoth(line.text);
                    break;
                case DiffLineKind::Addition:
                    right.append(line.text).push_back('\n');
                    break;
                case DiffLineKind::Deletion:
                    left.append(line.text).push_back('\n');
                    break;
                }
            }
        }
    }
    return {std::move(left), std::move(right)};
}

// kit::elide drops the tail, which for a repository path throws away the
// basename -- the only part that identifies the file. Drop leading components
// instead so the filename always survives a narrow panel.
std::string elideLeading(std::string_view path, float maxWidth) {
    if (maxWidth <= 0.0F) return {};
    if (ImGui::CalcTextSize(path.data(), path.data() + path.size()).x <= maxWidth) {
        return std::string(path);
    }

    constexpr std::string_view prefix = "…";
    if (ImGui::CalcTextSize(prefix.data(), prefix.data() + prefix.size()).x > maxWidth) {
        return {};
    }

    // Grow the retained tail one UTF-8 code point at a time so a multi-byte
    // glyph is never split in half.
    std::size_t kept = path.size();
    for (std::size_t cursor = path.size(); cursor > 0;) {
        std::size_t start = cursor - 1;
        while (start > 0 && (static_cast<unsigned char>(path[start]) & 0xC0U) == 0x80U) --start;
        std::string candidate(prefix);
        candidate.append(path.substr(start));
        if (ImGui::CalcTextSize(candidate.c_str()).x > maxWidth) break;
        kept = start;
        cursor = start;
    }
    std::string result(prefix);
    result.append(path.substr(kept));
    return result;
}

// The Source Control panel is roughly 250px of usable width, so any fixed
// buttons-per-row split either wastes a row or pushes an action off-panel.
// Every label is measured and wrapped onto a further row when it will not fit.
class ActionFlow {
public:
    ActionFlow()
        : lineWidth_(ImGui::GetContentRegionAvail().x), remaining_(lineWidth_) {}

    void place(const char* label) {
        const ImGuiStyle& style = ImGui::GetStyle();
        const float width = ImGui::CalcTextSize(label).x + style.FramePadding.x * 2.0F;
        if (placed_ && width + style.ItemSpacing.x <= remaining_) {
            ImGui::SameLine();
            remaining_ -= width + style.ItemSpacing.x;
            return;
        }
        // A button already ended the line, so the new row needs no SameLine.
        placed_ = true;
        remaining_ = lineWidth_ - width;
    }

private:
    float lineWidth_;
    float remaining_;
    bool placed_ = false;
};

bool flowButton(ActionFlow& flow, const char* label, bool primary, bool enabled) {
    flow.place(label);
    return primary ? kit::primaryButton(label, {}, enabled)
                   : kit::secondaryButton(label, {}, enabled);
}

} // namespace

std::vector<StatusGroup> groupFiles(const std::vector<GitFileState>& files) {
    std::vector<StatusGroup> groups = {
        {StatusGroupKind::Conflicts, {}}, {StatusGroupKind::Staged, {}},
        {StatusGroupKind::Changes, {}}, {StatusGroupKind::Untracked, {}}};
    for (const GitFileState& file : files) {
        if (isConflict(file)) {
            groups[0].files.push_back(file);
            continue;
        }
        if (file.untracked) {
            groups[3].files.push_back(file);
            continue;
        }
        if (nonEmptyStatus(file.staged)) groups[1].files.push_back(file);
        if (nonEmptyStatus(file.unstaged)) groups[2].files.push_back(file);
    }
    for (StatusGroup& group : groups) {
        std::sort(group.files.begin(), group.files.end(), [](const GitFileState& lhs,
                                                            const GitFileState& rhs) {
            return lhs.path < rhs.path;
        });
    }
    return groups;
}

std::string_view statusGroupLabel(StatusGroupKind kind) noexcept {
    switch (kind) {
    case StatusGroupKind::Conflicts: return "Conflicts";
    case StatusGroupKind::Staged: return "Staged Changes";
    case StatusGroupKind::Changes: return "Changes";
    case StatusGroupKind::Untracked: return "Untracked";
    }
    return "Changes";
}

Json VcsRequestFactory::workspaceParams() const { return Json{{"workspaceId", workspaceId_}}; }

VcsRequest VcsRequestFactory::snapshot() const { return {"git.snapshot", workspaceParams()}; }

VcsRequest VcsRequestFactory::diff(std::optional<std::string> path,
                                   std::optional<bool> staged) const {
    Json params = workspaceParams();
    if (path) params["path"] = std::move(*path);
    if (staged) params["staged"] = *staged;
    return {"git.diff", std::move(params)};
}

VcsRequest VcsRequestFactory::stage(const std::vector<std::string>& paths) const {
    Json params = workspaceParams();
    params["paths"] = paths;
    return {"git.stage", std::move(params)};
}

VcsRequest VcsRequestFactory::unstage(const std::vector<std::string>& paths) const {
    Json params = workspaceParams();
    params["paths"] = paths;
    return {"git.unstage", std::move(params)};
}

VcsRequest VcsRequestFactory::commit(std::string message) const {
    Json params = workspaceParams();
    params["message"] = std::move(message);
    return {"git.commit", std::move(params)};
}

VcsRequest VcsRequestFactory::branches() const { return {"git.branches", workspaceParams()}; }

VcsRequest VcsRequestFactory::createBranch(std::string name,
                                           std::optional<std::string> startPoint,
                                           bool checkoutBranch) const {
    Json params = workspaceParams();
    params["name"] = std::move(name);
    if (startPoint) params["startPoint"] = std::move(*startPoint);
    params["checkout"] = checkoutBranch;
    return {"git.branch.create", std::move(params)};
}

VcsRequest VcsRequestFactory::checkout(std::string ref, bool hasChanges) const {
    Json params = workspaceParams();
    params["ref"] = std::move(ref);
    VcsRequest request{"git.checkout", std::move(params)};
    request.destructive = hasChanges;
    if (hasChanges) {
        request.confirmation = "Checkout may overwrite or hide local changes. Continue only if they are safe.";
    }
    return request;
}

VcsRequest VcsRequestFactory::fetch(std::optional<std::string> remote) const {
    Json params = workspaceParams();
    if (remote) params["remote"] = std::move(*remote);
    return {"git.fetch", std::move(params)};
}

VcsRequest VcsRequestFactory::pull(std::optional<std::string> remote,
                                   std::optional<std::string> branch) const {
    Json params = workspaceParams();
    if (remote) params["remote"] = std::move(*remote);
    if (branch) params["branch"] = std::move(*branch);
    return {"git.pull", std::move(params)};
}

VcsRequest VcsRequestFactory::push(std::optional<std::string> remote,
                                   std::optional<std::string> branch,
                                   bool setUpstream) const {
    Json params = workspaceParams();
    if (remote) params["remote"] = std::move(*remote);
    if (branch) params["branch"] = std::move(*branch);
    params["setUpstream"] = setUpstream;
    return {"git.push", std::move(params)};
}

VcsRequest VcsRequestFactory::remotes() const { return {"git.remotes", workspaceParams()}; }

VcsRequest VcsRequestFactory::historyGraph() const {
    Json params = workspaceParams();
    params["kind"] = "git";
    return {"graph.snapshot", std::move(params)};
}

VcsRequest VcsRequestFactory::hunk(std::string path, std::string hunkId,
                                   HunkAction action) const {
    Json params = workspaceParams();
    params["path"] = std::move(path);
    params["hunkId"] = std::move(hunkId);
    params["action"] = actionText(action);
    VcsRequest request{"git.hunk", std::move(params)};
    if (action == HunkAction::Revert) {
        request.destructive = true;
        request.confirmation = "Revert permanently discards the selected working-tree hunk.";
    }
    return request;
}

VcsView::VcsView(SubmitRequest submit, OpenGitGraph openGitGraph)
    : submit_(std::move(submit)), openGitGraph_(std::move(openGitGraph)),
      textDiff_(std::make_unique<TextDiff>()), alive_(std::make_shared<bool>(true)) {}

VcsView::~VcsView() { *alive_ = false; }

void VcsView::setWorkspace(std::string workspaceId) {
    if (workspaceId_ == workspaceId) return;
    workspaceId_ = std::move(workspaceId);
    snapshot_.reset();
    groups_ = groupFiles({});
    branches_.clear();
    remotes_.clear();
    diff_ = {};
    animator_.reconcile(diff_);
    selectedPath_.reset();
    confirmation_.reset();
    error_.reset();
    busyMethod_.clear();
}

void VcsView::sync(const GitSnapshot& snapshotValue) {
    if (snapshot_ && *snapshot_ == snapshotValue) return;
    snapshot_ = snapshotValue;
    groups_ = groupFiles(snapshotValue.files);
}

void VcsView::sync(const std::optional<GitSnapshot>& snapshotValue) {
    if (snapshotValue) sync(*snapshotValue);
}

void VcsView::refresh() {
    if (!workspaceId_.empty()) dispatch(VcsRequestFactory(workspaceId_).snapshot());
}

void VcsView::requestDiff(std::optional<std::string> path, bool staged) {
    if (workspaceId_.empty()) return;
    selectedPath_ = path;
    selectedStaged_ = staged;
    dispatch(VcsRequestFactory(workspaceId_).diff(std::move(path), staged));
}

void VcsView::stageFiles(const std::vector<std::string>& paths) {
    if (!workspaceId_.empty() && !paths.empty()) dispatch(VcsRequestFactory(workspaceId_).stage(uniquePaths(paths)));
}

void VcsView::unstageFiles(const std::vector<std::string>& paths) {
    if (!workspaceId_.empty() && !paths.empty()) dispatch(VcsRequestFactory(workspaceId_).unstage(uniquePaths(paths)));
}

void VcsView::stageAll() {
    std::vector<std::string> paths;
    for (StatusGroupKind kind : {StatusGroupKind::Conflicts, StatusGroupKind::Changes,
                                 StatusGroupKind::Untracked}) {
        const auto groupPaths = pathsFor(kind);
        paths.insert(paths.end(), groupPaths.begin(), groupPaths.end());
    }
    stageFiles(paths);
}

void VcsView::unstageAll() {
    std::vector<std::string> paths;
    if (snapshot_) {
        for (const GitFileState& file : snapshot_->files) {
            if (nonEmptyStatus(file.staged)) paths.push_back(file.path);
        }
    }
    unstageFiles(paths);
}

void VcsView::commit(std::string message) {
    const bool blank = std::all_of(message.begin(), message.end(), [](unsigned char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n'; });
    if (workspaceId_.empty() || message.empty() || blank) {
        error_ = "A commit message is required.";
        return;
    }
    dispatch(VcsRequestFactory(workspaceId_).commit(std::move(message)));
}

void VcsView::refreshBranches() {
    if (!workspaceId_.empty()) dispatch(VcsRequestFactory(workspaceId_).branches());
}

void VcsView::createBranch(std::string name, std::optional<std::string> startPoint,
                           bool checkoutBranch) {
    if (workspaceId_.empty() || name.empty()) {
        error_ = "A branch name is required.";
        return;
    }
    dispatch(VcsRequestFactory(workspaceId_).createBranch(std::move(name), std::move(startPoint),
                                                           checkoutBranch));
}

void VcsView::checkout(std::string ref) {
    if (workspaceId_.empty() || ref.empty()) return;
    dispatch(VcsRequestFactory(workspaceId_).checkout(std::move(ref), hasLocalChanges()));
}

void VcsView::fetch(std::optional<std::string> remote) {
    if (!workspaceId_.empty()) dispatch(VcsRequestFactory(workspaceId_).fetch(std::move(remote)));
}

void VcsView::pull(std::optional<std::string> remote, std::optional<std::string> branch) {
    if (!workspaceId_.empty()) dispatch(VcsRequestFactory(workspaceId_).pull(std::move(remote), std::move(branch)));
}

void VcsView::push(std::optional<std::string> remote, std::optional<std::string> branch,
                   bool setUpstream) {
    if (!workspaceId_.empty()) dispatch(VcsRequestFactory(workspaceId_).push(std::move(remote), std::move(branch), setUpstream));
}

void VcsView::refreshRemotes() {
    if (!workspaceId_.empty()) dispatch(VcsRequestFactory(workspaceId_).remotes());
}

void VcsView::openHistory() {
    if (openGitGraph_) openGitGraph_();
    if (!workspaceId_.empty()) dispatch(VcsRequestFactory(workspaceId_).historyGraph());
}

bool VcsView::actOnHunk(const DiffFile& file, const DiffHunk& hunk, HunkAction action) {
    const HunkGate gate = gateHunkAction(file, hunk, action);
    if (!gate.allowed) {
        error_ = gate.reason;
        return false;
    }
    dispatch(VcsRequestFactory(workspaceId_).hunk(std::string(file.displayPath()), hunk.id, action));
    return true;
}

void VcsView::confirmPending(bool accepted) {
    if (!confirmation_) return;
    VcsRequest request = std::move(confirmation_->request);
    confirmation_.reset();
    if (accepted) dispatch(std::move(request), true);
}

void VcsView::acceptDiff(std::string_view unified) {
    diff_ = parseUnifiedDiff(unified);
    animator_.reconcile(diff_);
    const auto [left, right] = diffSides(diff_);
    textDiff_->SetText(left, right);
}

void VcsView::acceptBranches(std::vector<GitBranch> branches) {
    std::sort(branches.begin(), branches.end(), [](const GitBranch& lhs, const GitBranch& rhs) {
        if (lhs.current != rhs.current) return lhs.current;
        if (lhs.remote != rhs.remote) return !lhs.remote;
        return lhs.name < rhs.name;
    });
    branches_ = std::move(branches);
}

void VcsView::acceptRemotes(std::vector<GitRemote> remotes) {
    std::sort(remotes.begin(), remotes.end(), [](const GitRemote& lhs, const GitRemote& rhs) {
        return lhs.name < rhs.name;
    });
    remotes_ = std::move(remotes);
}

void VcsView::advanceAnimations(float deltaSeconds) {
    animator_.setReducedMotion(anim::motionScale() <= 0.0F);
    animator_.advance(deltaSeconds);
    if (std::any_of(animator_.lines().begin(), animator_.lines().end(),
                    [](const AnimatedDiffLine& line) {
                        return line.motion != LineMotion::Stable;
                    })) {
        anim::requestFrames();
    }
}

void VcsView::dispatch(VcsRequest request, bool bypassConfirmation) {
    if (request.destructive && !bypassConfirmation) {
        confirmation_ = PendingConfirmation{std::move(request), "Confirm destructive Git action"};
        return;
    }
    dispatchNow(std::move(request));
}

void VcsView::dispatchNow(VcsRequest request) {
    if (!submit_) {
        error_ = "Source Control transport is unavailable.";
        return;
    }
    error_.reset();
    busyMethod_ = request.method;
    const std::weak_ptr<bool> alive = alive_;
    submit_(request, [this, alive, request](const ResponseFrame& response) {
        const auto token = alive.lock();
        if (!token || !*token) return;
        handleResponse(request, response);
    });
}

void VcsView::handleResponse(const VcsRequest& request, const ResponseFrame& response) {
    busyMethod_.clear();
    if (response.error) {
        error_ = response.error->message.empty() ? response.error->code
                                                 : response.error->code + ": " + response.error->message;
        return;
    }
    if (!response.result) {
        error_ = "Git request returned no result.";
        return;
    }
    try {
        const Json& result = *response.result;
        if (request.method == "git.diff") {
            acceptDiff(result.at("unified").get<std::string>());
        } else if (request.method == "git.branches") {
            std::vector<GitBranch> values;
            for (const Json& value : result.at("branches")) values.push_back(parseBranch(value));
            acceptBranches(std::move(values));
        } else if (request.method == "git.remotes") {
            std::vector<GitRemote> values;
            for (const Json& value : result.at("remotes")) values.push_back(parseRemote(value));
            acceptRemotes(std::move(values));
        } else if (result.contains("snapshot")) {
            sync(json_codec::parseGitSnapshot(result.at("snapshot")));
            if (request.method == "git.commit") commitBuffer_.fill('\0');
        }
    } catch (const std::exception& exception) {
        error_ = std::string("Invalid Git response: ") + exception.what();
    }
}

bool VcsView::hasLocalChanges() const noexcept {
    return snapshot_ && !snapshot_->files.empty();
}

std::vector<std::string> VcsView::pathsFor(StatusGroupKind kind) const {
    const auto found = std::find_if(groups_.begin(), groups_.end(), [kind](const StatusGroup& group) {
        return group.kind == kind;
    });
    std::vector<std::string> result;
    if (found == groups_.end()) return result;
    result.reserve(found->files.size());
    for (const GitFileState& file : found->files) result.push_back(file.path);
    return result;
}

void VcsView::drawToolbar() {
    // Five actions never fit one row of a ~250px side panel: "History" used to
    // render as "Hi" and "Refresh" landed entirely off-panel, unclickable.
    ActionFlow flow;
    const bool ready = !busy();
    if (flowButton(flow, "Fetch", false, ready)) fetch();
    if (flowButton(flow, "Pull", false, ready)) pull();
    if (flowButton(flow, "Push", true, ready)) push();
    if (flowButton(flow, "History", false, ready)) openHistory();
    if (flowButton(flow, "Refresh", false, ready)) refresh();
}

void VcsView::drawCommit() {
    kit::sectionHeader("Commit", {.first = true});
    // An empty rounded rect reads as dead space, so the box carries a hint.
    // Dear ImGui offers no multi-line InputTextWithHint; InputTextEx is the
    // upstream-documented way to combine Multiline with a placeholder.
    ImGui::InputTextEx("##commit-message", "Describe the change…", commitBuffer_.data(),
                       static_cast<int>(commitBuffer_.size()),
                       ImVec2(-1.0F, ImGui::GetTextLineHeight() * 3.0F),
                       ImGuiInputTextFlags_Multiline);
    const bool hasStaged = !pathsFor(StatusGroupKind::Staged).empty();
    if (kit::primaryButton("Commit staged changes", {}, hasStaged && !busy(),
                           hasStaged ? nullptr : "Stage at least one change first")) {
        commit(std::string(commitBuffer_.data()));
    }
}

void VcsView::drawBulkActions() {
    bool anyStaged = false;
    bool anyUnstaged = false;
    for (const StatusGroup& group : groups_) {
        if (group.files.empty()) continue;
        if (group.kind == StatusGroupKind::Staged) {
            anyStaged = true;
        } else {
            // stageAll covers conflicts, changes and untracked files.
            anyUnstaged = true;
        }
    }
    if (!anyStaged && !anyUnstaged) return;
    ActionFlow flow;
    const bool ready = !busy();
    if (anyUnstaged && flowButton(flow, "Stage all", false, ready)) stageAll();
    if (anyStaged && flowButton(flow, "Unstage all", false, ready)) unstageAll();
}

void VcsView::drawGroups(float height) {
    // The bulk actions are pinned above the scroll region. Inside it they ate
    // the last visible line and left the next group header clipped mid-glyph.
    const float top = ImGui::GetCursorPosY();
    drawBulkActions();
    const float pinned = ImGui::GetCursorPosY() - top;
    ImGui::BeginChild("##status-groups",
                      ImVec2(0.0F, std::max(ImGui::GetFrameHeight(), height - pinned)),
                      ImGuiChildFlags_Borders);
    for (const StatusGroup& group : groups_) {
        if (group.files.empty()) continue;
        const std::string header(statusGroupLabel(group.kind));
        kit::sectionHeader(header.c_str(), {.count = static_cast<int>(group.files.size())});
        const bool stagedGroup = group.kind == StatusGroupKind::Staged;
        for (const GitFileState& file : group.files) {
            ImGui::PushID(group.kind == StatusGroupKind::Staged ? "staged" : "working");
            ImGui::PushID(file.path.c_str());
            kit::RowStyle style;
            style.secondary = statusLabel(file, group.kind);
            // A row-level tooltip would override the stage/unstage button hint,
            // so the full path hangs off the label item that was elided.
            style.selected = selectedPath_ && *selectedPath_ == file.path && selectedStaged_ == stagedGroup;
            style.iconTone = groupTone(group.kind);
            const ImGuiStyle& imStyle = ImGui::GetStyle();
            const char* actionLabel = stagedGroup ? "-" : "+";
            const float actionWidth =
                ImGui::CalcTextSize(actionLabel).x + imStyle.FramePadding.x * 2.0F;
            style.actionsWidth = actionWidth;
            if (kit::rowBegin("##file", style)) requestDiff(file.path, stagedGroup);
            const float rowRight = ImGui::GetCursorPosX() + ImGui::GetContentRegionAvail().x;
            const float pathWidth =
                ImGui::GetContentRegionAvail().x - actionWidth - imStyle.ItemSpacing.x;
            ImGui::TextUnformatted(elideLeading(file.path, pathWidth).c_str());
            if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", file.path.c_str());
            ImGui::SameLine();
            ImGui::SetCursorPosX(std::max(ImGui::GetCursorPosX(), rowRight - actionWidth));
            if (stagedGroup) {
                if (ImGui::SmallButton(actionLabel)) unstageFiles({file.path});
                if (ImGui::IsItemHovered()) ImGui::SetTooltip("Unstage file");
            } else {
                if (ImGui::SmallButton(actionLabel)) stageFiles({file.path});
                if (ImGui::IsItemHovered()) ImGui::SetTooltip("Stage file");
            }
            kit::rowEnd();
            ImGui::PopID();
            ImGui::PopID();
        }
    }
    if (!snapshot_) {
        (void)kit::emptyState("No repository snapshot",
                              "Open a Git workspace or refresh Source Control.");
    } else if (snapshot_->files.empty()) {
        (void)kit::emptyState("Working tree clean",
                              "There are no staged or unstaged changes.");
    }
    ImGui::EndChild();
}

void VcsView::drawBranchesAndRemotes() {
    if (!ImGui::CollapsingHeader("Branches and remotes")) return;
    if (branches_.empty() && kit::secondaryButton("Load branches")) refreshBranches();
    for (const GitBranch& branch : branches_) {
        ImGui::PushID(branch.name.c_str());
        const std::string label = branch.current ? branch.name + " (current)" : branch.name;
        if (ImGui::Selectable(label.c_str(), branch.current)) checkout(branch.name);
        if (branch.ahead || branch.behind) {
            ImGui::SameLine();
            ImGui::TextDisabled("+%lld -%lld", static_cast<long long>(branch.ahead.value_or(0)),
                                static_cast<long long>(branch.behind.value_or(0)));
        }
        ImGui::PopID();
    }
    ImGui::SetNextItemWidth(-100.0F);
    ImGui::InputTextWithHint("##new-branch", "new branch", branchBuffer_.data(), branchBuffer_.size());
    ImGui::SameLine();
    if (kit::secondaryButton("Create") && branchBuffer_[0] != '\0') {
        createBranch(branchBuffer_.data());
        branchBuffer_.fill('\0');
    }
    if (remotes_.empty() && kit::secondaryButton("Load remotes")) refreshRemotes();
    for (const GitRemote& remote : remotes_) {
        kit::keyValueRow(remote.name.c_str(), remote.fetchUrl.c_str(), kit::Tone::Info, true);
    }
}

void VcsView::drawDiff(float height) {
    if (!selectedPath_) return;
    kit::sectionHeader(selectedStaged_ ? "Staged diff" : "Working-tree diff");
    if (diff_.files.empty()) {
        (void)kit::emptyState("No textual diff",
                              "The file may be unchanged, binary, or unavailable.");
        return;
    }

    if (ImGui::CollapsingHeader("Hunk actions", ImGuiTreeNodeFlags_DefaultOpen)) {
        for (const DiffFile& file : diff_.files) {
            ImGui::PushID(file.id.c_str());
            ImGui::TextColored(ui::palette().diffHeader, "%s",
                               std::string(file.displayPath()).c_str());
            for (const std::string& metadata : file.metadata) {
                ImGui::TextDisabled("%s", metadata.c_str());
            }
            for (const DiffHunk& hunk : file.hunks) {
                ImGui::PushID(hunk.id.c_str());
                ImGui::TextColored(ui::palette().diffHunk, "%s", hunk.header.c_str());
                ImGui::SameLine();
                const HunkAction primary =
                    selectedStaged_ ? HunkAction::Unstage : HunkAction::Stage;
                const HunkGate primaryGate = gateHunkAction(file, hunk, primary);
                if (kit::secondaryButton(selectedStaged_ ? "Unstage hunk" : "Stage hunk", {},
                                         primaryGate.allowed && !busy(),
                                         primaryGate.reason.c_str())) {
                    actOnHunk(file, hunk, primary);
                }
                if (!selectedStaged_) {
                    ImGui::SameLine();
                    const HunkGate revertGate =
                        gateHunkAction(file, hunk, HunkAction::Revert);
                    if (kit::dangerButton("Revert hunk", {},
                                          revertGate.allowed && !busy(),
                                          revertGate.reason.c_str())) {
                        actOnHunk(file, hunk, HunkAction::Revert);
                    }
                }
                ImGui::PopID();
            }
            ImGui::PopID();
        }
    }

    // TextDiff is the editor vendor's read-only, selectable renderer. The VCS
    // parser remains authoritative only for stable action IDs, safety and motion.
    textDiff_->SetSideBySideMode(ImGui::GetContentRegionAvail().x >= 760.0F);
    textDiff_->SetColors(ui::toU32(ui::palette().diffAddWash),
                         ui::toU32(ui::palette().diffDeleteWash));
    textDiff_->Render("##readonly-diff-fence", ImVec2(0.0F, height),
                      ImGuiChildFlags_Borders,
                      ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings);
}

void VcsView::drawConfirmation() {
    if (!confirmation_) return;
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().statusErrWash);
    ImGui::BeginChild("##destructive-confirmation", ImVec2(0.0F, 92.0F), ImGuiChildFlags_Borders);
    ImGui::TextUnformatted(confirmation_->title.c_str());
    ImGui::TextWrapped("%s", confirmation_->request.confirmation.c_str());
    if (kit::dangerButton("Confirm")) confirmPending(true);
    ImGui::SameLine();
    if (kit::secondaryButton("Cancel")) confirmPending(false);
    ImGui::EndChild();
    ImGui::PopStyleColor();
}

void VcsView::draw(const char* id, ImVec2 size) {
    advanceAnimations(ImGui::GetIO().DeltaTime);
    ImGui::BeginChild(id, size, ImGuiChildFlags_None);
    drawToolbar();
    if (error_) {
        if (kit::blockedState("Source Control error", error_->c_str(), "Dismiss")) clearError();
    }
    drawConfirmation();
    drawCommit();
    const float available = ImGui::GetContentRegionAvail().y;
    drawGroups(std::max(140.0F, available * (selectedPath_ ? 0.40F : 0.68F)));
    drawBranchesAndRemotes();
    if (selectedPath_) drawDiff(std::max(160.0F, ImGui::GetContentRegionAvail().y));
    ImGui::EndChild();
}

} // namespace chud::vcs
