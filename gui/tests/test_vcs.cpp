#include "vcs/diff_model.h"
#include "vcs/vcs_view.h"

#include <algorithm>
#include <cassert>
#include <iostream>
#include <optional>
#include <string>
#include <utility>
#include <vector>

using namespace chud;
using namespace chud::vcs;

namespace {

constexpr std::string_view kTextDiff =
    "diff --git a/src/a.cpp b/src/a.cpp\n"
    "index 1111111..2222222 100644\n"
    "--- a/src/a.cpp\n"
    "+++ b/src/a.cpp\n"
    "@@ -1,3 +1,4 @@ function\n"
    " keep\n"
    "-old\n"
    "+new\n"
    "+extra\n"
    " tail\n"
    "\\ No newline at end of file\n";

GitSnapshot snapshot(std::vector<GitFileState> files = {}) {
    return {"/repo", "main", std::optional<std::string>("origin/main"), 2, 1,
            std::move(files), {}};
}

const StatusGroup& group(const std::vector<StatusGroup>& groups, StatusGroupKind kind) {
    for (const StatusGroup& candidate : groups) {
        if (candidate.kind == kind) return candidate;
    }
    assert(false);
    return groups.front();
}

void testUnifiedParserAndStableIds() {
    const DiffDocument first = parseUnifiedDiff(kTextDiff);
    const DiffDocument second = parseUnifiedDiff(kTextDiff);
    assert(first == second);
    assert(first.files.size() == 1);
    const DiffFile& file = first.files.front();
    assert(file.oldPath == "src/a.cpp" && file.newPath == "src/a.cpp");
    assert(file.kind == DiffFileKind::Modified);
    assert(file.hunks.size() == 1);
    const DiffHunk& hunk = file.hunks.front();
    assert((hunk.oldRange == DiffRange{1, 3}));
    assert((hunk.newRange == DiffRange{1, 4}));
    assert(hunk.lines.size() == 6);
    assert(hunk.lines[0].oldLine == 1 && hunk.lines[0].newLine == 1);
    assert(hunk.lines[1].kind == DiffLineKind::Deletion && hunk.lines[1].oldLine == 2 &&
           !hunk.lines[1].newLine);
    assert(hunk.lines[2].kind == DiffLineKind::Addition && hunk.lines[2].newLine == 2 &&
           !hunk.lines[2].oldLine);
    assert(hunk.lines[5].kind == DiffLineKind::NoNewline);
    assert(!file.id.empty() && !hunk.id.empty() && !hunk.lines[0].id.empty());

    const std::string reordered =
        "diff --git a/z.cpp b/z.cpp\n--- a/z.cpp\n+++ b/z.cpp\n@@ -1 +1 @@\n-x\n+y\n" +
        std::string(kTextDiff);
    const DiffDocument withPrefix = parseUnifiedDiff(reordered);
    assert(withPrefix.files.size() == 2);
    assert(withPrefix.files[1].id == file.id);
    assert(withPrefix.files[1].hunks[0].id == hunk.id);
    assert(withPrefix.files[1].hunks[0].lines[0].id == hunk.lines[0].id);
}

void testSpecialFilesAndHunkGating() {
    const DiffDocument parsed = parseUnifiedDiff(
        "diff --git \"a/evil; $(touch nope)\" \"b/evil; $(touch nope)\"\n"
        "old mode 100644\nnew mode 100755\n"
        "--- \"a/evil; $(touch nope)\"\n+++ \"b/evil; $(touch nope)\"\n"
        "@@ -1 +1 @@\n-a\n+b\n"
        "diff --git a/old.bin b/new.bin\n"
        "similarity index 100%\nrename from old.bin\nrename to new.bin\n"
        "Binary files a/old.bin and b/new.bin differ\n"
        "diff --git a/sub b/sub\nindex 111..222 160000\n"
        "--- a/sub\n+++ b/sub\n@@ -1 +1 @@\n-Subproject commit 111\n+Subproject commit 222\n");
    assert(parsed.files.size() == 3);
    assert(parsed.files[0].displayPath() == "evil; $(touch nope)");
    assert(parsed.files[0].modeChanged && parsed.files[0].kind == DiffFileKind::ModeChanged);
    assert(!gateHunkAction(parsed.files[0], parsed.files[0].hunks[0], HunkAction::Stage).allowed);
    assert(parsed.files[1].binary && parsed.files[1].renamed);
    assert(parsed.files[1].kind == DiffFileKind::Binary);
    assert(!gateHunkAction(parsed.files[1], parsed.files[0].hunks[0],
                           HunkAction::Stage).allowed);
    DiffFile textualRename = parsed.files[0];
    textualRename.binary = false;
    textualRename.modeChanged = false;
    textualRename.renamed = true;
    textualRename.kind = DiffFileKind::Renamed;
    assert(!gateHunkAction(textualRename, textualRename.hunks[0],
                           HunkAction::Unstage).allowed);
    assert(parsed.files[2].submodule && parsed.files[2].kind == DiffFileKind::Submodule);
    assert(!gateHunkAction(parsed.files[2], parsed.files[2].hunks[0], HunkAction::Revert).allowed);

    const DiffDocument added = parseUnifiedDiff(
        "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n"
        "@@ -0,0 +1 @@\n+x\n");
    assert(added.files[0].kind == DiffFileKind::Added);
    assert(!gateHunkAction(added.files[0], added.files[0].hunks[0], HunkAction::Revert).allowed);
    assert(gateHunkAction(added.files[0], added.files[0].hunks[0], HunkAction::Stage).allowed);
}

void testGroupingAndRequests() {
    const std::vector<GitFileState> files = {
        {"both.cpp", "M", "M", false},
        {"conflict.cpp", "U", "U", false},
        {"staged.cpp", "A", "", false},
        {"new; rm -rf -- /", "?", "?", true},
    };
    const auto groups = groupFiles(files);
    assert(group(groups, StatusGroupKind::Conflicts).files.size() == 1);
    assert(group(groups, StatusGroupKind::Staged).files.size() == 2);
    assert(group(groups, StatusGroupKind::Changes).files.size() == 1);
    assert(group(groups, StatusGroupKind::Untracked).files.size() == 1);

    VcsRequestFactory factory("workspace-1");
    const VcsRequest stage = factory.stage({"new; rm -rf -- /", "a\n--path"});
    assert(stage.method == "git.stage");
    assert(stage.params == Json({{"workspaceId", "workspace-1"},
                                 {"paths", Json::array({"new; rm -rf -- /", "a\n--path"})}}));
    const VcsRequest diff = factory.diff("evil --output=/tmp/pwn", false);
    assert(diff.params.at("path") == "evil --output=/tmp/pwn");
    assert(diff.params.at("staged") == false);
    assert(factory.fetch().params == Json({{"workspaceId", "workspace-1"}}));
    assert(factory.pull("upstream", "topic").params ==
           Json({{"workspaceId", "workspace-1"}, {"remote", "upstream"}, {"branch", "topic"}}));
    assert(factory.push("origin", "topic", true).params.at("setUpstream") == true);
    assert(factory.createBranch("topic", "main", false).params ==
           Json({{"workspaceId", "workspace-1"}, {"name", "topic"},
                 {"startPoint", "main"}, {"checkout", false}}));
    assert(factory.historyGraph().params.at("kind") == "git");
    assert(factory.commit("subject").params.at("message") == "subject");
    assert(factory.branches().method == "git.branches");
    assert(factory.remotes().method == "git.remotes");
    const VcsRequest revert = factory.hunk("odd;path", "hunk-1", HunkAction::Revert);
    assert(revert.destructive && revert.params.at("action") == "revert");
    assert(revert.params.at("path") == "odd;path");
    assert(factory.checkout("other", true).destructive);
    assert(!factory.checkout("other", false).destructive);
}

void testAnimationAndScrollAnchor() {
    DiffDocument first = parseUnifiedDiff(kTextDiff);
    DiffAnimator animator;
    animator.reconcile(first);
    assert(!animator.lines().empty());
    for (const AnimatedDiffLine& line : animator.lines()) assert(line.motion == LineMotion::Inserting);
    animator.advance(1.0F);
    for (const AnimatedDiffLine& line : animator.lines()) assert(line.motion == LineMotion::Stable);

    const std::string anchorId = animator.lines()[2].line.id;
    animator.setScrollAnchor({anchorId, 7.5F});
    DiffDocument changed = first;
    changed.files[0].hunks[0].lines[2].text = "changed in place";
    changed.files[0].hunks[0].lines.erase(changed.files[0].hunks[0].lines.begin() + 1);
    animator.reconcile(changed);
    bool sawChange = false;
    bool sawRemoval = false;
    for (const AnimatedDiffLine& line : animator.lines()) {
        sawChange = sawChange || line.motion == LineMotion::Changing;
        sawRemoval = sawRemoval || line.motion == LineMotion::Removing;
    }
    assert(sawChange && sawRemoval);
    animator.reconcile(changed);
    assert(std::any_of(animator.lines().begin(), animator.lines().end(),
                       [](const AnimatedDiffLine& line) {
                           return line.motion == LineMotion::Removing;
                       }));
    assert(animator.scrollAnchor().lineId == anchorId);
    assert(animator.scrollAnchor().offset == 7.5F);
    animator.advance(1.0F);
    for (const AnimatedDiffLine& line : animator.lines()) assert(line.motion == LineMotion::Stable);

    animator.setReducedMotion(true);
    animator.reconcile(first);
    for (const AnimatedDiffLine& line : animator.lines()) {
        assert(line.motion == LineMotion::Stable && line.progress == 1.0F);
    }
}

void testViewActionsResponsesAndConfirmations() {
    std::vector<VcsRequest> sent;
    std::vector<VcsView::ResponseCallback> callbacks;
    int graphOpened = 0;
    VcsView view(
        [&](const VcsRequest& request, VcsView::ResponseCallback callback) {
            sent.push_back(request);
            callbacks.push_back(std::move(callback));
        },
        [&] { ++graphOpened; });
    view.setWorkspace("w");
    view.sync(snapshot({{"both.cpp", "M", "M", false},
                        {"only-stage.cpp", "A", "", false},
                        {"new;echo hostile", "?", "?", true}}));
    const auto groupsBefore = view.groups();
    view.sync(*view.snapshot());
    assert(view.groups() == groupsBefore); // sync is idempotent.

    view.stageAll();
    assert(sent.back().method == "git.stage");
    const auto stagedPaths = sent.back().params.at("paths").get<std::vector<std::string>>();
    assert((stagedPaths == std::vector<std::string>{"both.cpp", "new;echo hostile"}));
    assert(sent.back().params.at("paths")[1] == "new;echo hostile");

    view.commit(" \n\t");
    assert(view.error() && *view.error() == "A commit message is required.");
    view.clearError();

    view.refreshBranches();
    const std::size_t branchResponse = callbacks.size() - 1;
    callbacks[branchResponse]({42, "git.branches",
        Json{{"branches", Json::array({
            {{"name", "z"}, {"current", false}, {"remote", true}},
            {{"name", "main"}, {"current", true}, {"remote", false},
             {"upstream", "origin/main"}, {"ahead", 2}, {"behind", 1}}
        })}}, std::nullopt});
    assert(view.branches().size() == 2 && view.branches()[0].name == "main");

    view.refreshRemotes();
    callbacks.back()({43, "git.remotes",
        Json{{"remotes", Json::array({
            {{"name", "origin"}, {"fetchUrl", "ssh://fetch"}, {"pushUrl", "ssh://push"}}
        })}}, std::nullopt});
    assert(view.remotes().size() == 1 && view.remotes()[0].pushUrl == "ssh://push");

    const std::size_t sentBeforeCheckout = sent.size();
    view.checkout("other");
    assert(sent.size() == sentBeforeCheckout);
    assert(view.pendingConfirmation());
    assert(view.pendingConfirmation()->request.params.at("ref") == "other");
    view.confirmPending(false);
    assert(sent.size() == sentBeforeCheckout);
    view.checkout("other");
    view.confirmPending(true);
    assert(sent.back().method == "git.checkout");

    view.openHistory();
    assert(graphOpened == 1);
    assert(sent.back().method == "graph.snapshot" && sent.back().params.at("kind") == "git");

    callbacks.back()({44, "graph.snapshot", std::nullopt,
                      ResponseError{"git-failed", "remote rejected"}});
    assert(view.error() && view.error()->find("remote rejected") != std::string::npos);
}

void testHunkActionUsesParsedIdentity() {
    std::vector<VcsRequest> sent;
    VcsView view([&](const VcsRequest& request, VcsView::ResponseCallback) { sent.push_back(request); });
    view.setWorkspace("w");
    view.acceptDiff(kTextDiff);
    const DiffFile& file = view.diff().files[0];
    const DiffHunk& hunk = file.hunks[0];
    assert(view.actOnHunk(file, hunk, HunkAction::Stage));
    assert(sent.back().params.at("hunkId") == hunk.id);
    assert(sent.back().params.at("path") == "src/a.cpp");
    assert(sent.back().params.at("action") == "stage");

    assert(view.actOnHunk(file, hunk, HunkAction::Revert));
    assert(view.pendingConfirmation());
    assert(sent.size() == 1);
    view.confirmPending(true);
    assert(sent.size() == 2 && sent.back().params.at("action") == "revert");
}

} // namespace

int main() {
    testUnifiedParserAndStableIds();
    testSpecialFilesAndHunkGating();
    testGroupingAndRequests();
    testAnimationAndScrollAnchor();
    testViewActionsResponsesAndConfirmations();
    testHunkActionUsesParsedIdentity();
    std::cout << "vcs tests passed\n";
    return 0;
}
