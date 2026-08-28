#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include "editor/editor.h"
#include "net/ws_transport.h"
#include "protocol/desktop_client.h"
#include "protocol/desktop_store.h"
#include "protocol/json_codec.h"
#include "theme/anim.h"
#include "workspace/workspace_view.h"

namespace {
using namespace chud;

void check(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}

class FakeTransport final : public ITransport {
public:
    void start() override { started = true; }
    void stop() override { started = false; }
    bool sendText(std::string_view text) override {
        sent.push_back(std::get<RequestFrame>(json_codec::parseFrame(text)));
        return true;
    }
    std::vector<std::string> drainRaw() override {
        auto result = std::move(incoming);
        incoming.clear();
        return result;
    }
    bool connected() const noexcept override { return true; }
    std::size_t droppedIncoming() const noexcept override { return 0; }

    RequestFrame take(std::string_view method) {
        const auto found = std::find_if(sent.begin(), sent.end(), [&](const RequestFrame& request) {
            return request.method == method;
        });
        if (found == sent.end()) throw std::runtime_error("missing request: " + std::string(method));
        RequestFrame result = std::move(*found);
        sent.erase(found);
        return result;
    }

    bool started = false;
    std::vector<RequestFrame> sent;
    std::vector<std::string> incoming;
};

struct EditorProbe {
    struct Read { std::string workspaceId; std::string uri; };
    std::vector<Read> reads;
    std::unordered_map<std::string, std::string> textByUri;
    std::uint64_t generation = 1;

    editor::EditorRequests requests() {
        editor::EditorRequests value;
        value.read = [this](std::string workspaceId, std::string uri,
                            editor::EditorRequests::ReadCallback callback) {
            reads.push_back({workspaceId, uri});
            const auto found = textByUri.find(uri);
            const std::string text = found == textByUri.end() ? std::string{} : found->second;
            callback(editor::Snapshot{"doc:" + uri, uri, "cpp", text,
                editor::FileStamp{"sha:" + std::to_string(generation), text.size(), generation, generation}});
        };
        return value;
    }
};

struct Fixture {
    DesktopStore store;
    FakeTransport transport;
    DesktopClient client{transport, store};
    EditorProbe editorProbe;
    editor::EditorPanel editor{editorProbe.requests()};
    WorkspaceView view{client, store, editor};

    void respond(const RequestFrame& request, Json result) {
        transport.incoming.push_back(Json{{"t", "response"}, {"id", request.id},
            {"method", request.method}, {"result", std::move(result)}}.dump());
        client.drain();
    }
};

Json entry(std::string uri, std::string name, std::string relativePath,
           bool directory = false, bool ignored = false) {
    return {{"uri", std::move(uri)}, {"name", std::move(name)},
            {"relativePath", std::move(relativePath)}, {"directory", directory},
            {"ignored", ignored}, {"stamp", nullptr}};
}

WorkspaceDescriptor openWorkspace(Fixture& fixture, std::string root, std::string id,
                                  std::string name, Json rootEntries = Json::array()) {
    fixture.view.openProject(root);
    auto request = fixture.transport.take("workspace.open");
    check(request.params.at("rootPath") == root, "workspace.open root path was not preserved");
    WorkspaceDescriptor descriptor{id, root, name};
    fixture.respond(request, {{"workspace", {{"id", id}, {"rootPath", root}, {"displayName", name}}}});
    auto list = fixture.transport.take("workspace.list");
    check(list.params.at("workspaceId") == id && !list.params.contains("uri"),
          "opening a project did not lazily request its root");
    fixture.respond(list, {{"entries", std::move(rootEntries)}});
    return descriptor;
}

void testProjectRecentSelectionAndMultiProjectState() {
    Fixture fixture;
    fixture.view.refreshRecent();
    auto recent = fixture.transport.take("workspace.recent");
    fixture.respond(recent, {{"projects", Json::array({
        {{"rootPath", "/work/older"}, {"displayName", "older"}, {"lastOpenedMs", 2}},
        {{"rootPath", "/work/alpha"}, {"displayName", "alpha"}, {"lastOpenedMs", 9}}
    })}});
    check(fixture.view.recentProjects().size() == 2, "recent project response was not retained");
    check(fixture.view.recentProjects().front().rootPath == "/work/alpha",
          "recent projects were not ordered by last use");

    const auto alpha = openWorkspace(fixture, fixture.view.recentProjects().front().rootPath,
        "workspace-alpha", "alpha", Json::array({
            entry("file:///work/alpha/src", "src", "src", true),
            entry("file:///work/alpha/readme.txt", "readme.txt", "readme.txt")
        }));
    fixture.view.select("file:///work/alpha/src");
    fixture.view.setExpanded("file:///work/alpha/src", true);
    auto children = fixture.transport.take("workspace.list");
    check(children.params.at("uri") == "file:///work/alpha/src",
          "expansion did not issue a lazy child listing");
    fixture.respond(children, {{"entries", Json::array({
        entry("file:///work/alpha/src/main.cpp", "main.cpp", "src/main.cpp")
    })}});
    fixture.view.requestOpenFolder();
    auto pick = fixture.transport.take("workspace.pick");
    check(pick.params.at("initialPath") == alpha.rootPath,
          "Open Folder did not start at the current full path");
    fixture.respond(pick, {{"cancelled", true}});

    fixture.editorProbe.textByUri["file:///work/alpha/readme.txt"] = "alpha";
    check(fixture.view.openSource("file:///work/alpha/readme.txt"), "alpha source did not open");
    fixture.editor.processCallbacks();
    check(fixture.editorProbe.reads.size() == 1 &&
          fixture.editorProbe.reads.front().workspaceId == alpha.id,
          "alpha source was not associated with its workspace");
    fixture.editor.replaceText("file:///work/alpha/readme.txt", "alpha edited");
    editor::ViewState alphaView;
    alphaView.cursor = {3, 4, 3, 4};
    alphaView.firstVisibleLine = 2;
    fixture.editor.setView("file:///work/alpha/readme.txt", alphaView);

    const auto beta = openWorkspace(fixture, "/work/beta", "workspace-beta", "beta");
    fixture.view.select("file:///work/beta/selected.txt");
    check(fixture.view.workspaceId() == beta.id && fixture.view.rootPath() == beta.rootPath,
          "project switch did not update the active workspace identity");
    check(fixture.editor.tabs().size() == 1, "project switch closed an editor/session tab");
    const auto* alphaDocument = fixture.editor.document("file:///work/alpha/readme.txt");
    check(alphaDocument && alphaDocument->dirty && alphaDocument->text == "alpha edited" &&
          alphaDocument->view == alphaView, "project switch did not preserve the old editor session");
    check(fixture.view.projectStateCount() == 2, "second project replaced the first project state");

    fixture.editorProbe.textByUri["file:///work/beta/new.txt"] = "beta";
    check(fixture.view.openSource("file:///work/beta/new.txt"), "beta source did not open");
    fixture.editor.processCallbacks();
    check(fixture.editorProbe.reads.size() == 2 &&
          fixture.editorProbe.reads.back().workspaceId == beta.id,
          "beta source reused the previous project's workspace association");
    check(fixture.editor.tabs().size() == 2 &&
          fixture.editor.document("file:///work/alpha/readme.txt") != nullptr &&
          fixture.editor.document("file:///work/beta/new.txt") != nullptr,
          "new project did not open independently beside the old tab");

    fixture.view.setWorkspace(alpha);
    check(fixture.view.selectedUri() == "file:///work/alpha/src",
          "project selection cache was not restored");
    check(fixture.view.isExpanded("file:///work/alpha/src"),
          "project expansion cache was not restored");
    check(fixture.view.entries("file:///work/alpha/src").size() == 1,
          "lazy child cache was not restored");
    check(fixture.editor.workspace() == alpha.id, "editor workspace id did not follow project switch");
    check(fixture.editor.activeUri() == "file:///work/alpha/readme.txt",
          "returning to a project did not restore its active editor");
    check(fixture.editor.tabs().size() == 2 &&
          fixture.editor.document("file:///work/alpha/readme.txt")->dirty,
          "returning to the old project lost a cross-project editor session");
}


void testTreeBadgesAndFileActionRequests() {
    Fixture fixture;
    openWorkspace(fixture, "/repo", "workspace-repo", "repo", Json::array({
        entry("file:///repo/build", "build", "build", true, true),
        entry("file:///repo/source.cpp", "source.cpp", "source.cpp")
    }));
    check(fixture.view.entries().front().directory, "tree did not sort directories before files");
    check(fixture.view.isIgnored("file:///repo/build"), "ignored tree entry lost its badge state");

    GitSnapshot git{"/repo", "main", std::nullopt, 0, 0,
        {GitFileState{"source.cpp", "", "M", false}}, {}};
    fixture.store.apply(EventFrame{{GitEvent{"workspace-repo", std::move(git)}}});
    check(fixture.view.statusBadge("file:///repo/source.cpp") == "M",
          "Git status was not projected into a tree badge");

    fixture.view.create("file:///repo/new.cpp", false);
    fixture.view.create("file:///repo/include", true);
    fixture.view.rename("file:///repo/source.cpp", "file:///repo/main.cpp");
    fixture.view.copy("file:///repo/include", "file:///repo/include-copy", true);
    fixture.view.remove("file:///repo/main.cpp");
    fixture.view.reveal("file:///repo/include-copy");

    auto createFile = fixture.transport.take("workspace.create");
    auto createDirectory = fixture.transport.take("workspace.create");
    auto rename = fixture.transport.take("workspace.rename");
    auto copy = fixture.transport.take("workspace.copy");
    auto remove = fixture.transport.take("workspace.remove");
    auto reveal = fixture.transport.take("workspace.reveal");
    check(createFile.params == Json{{"workspaceId", "workspace-repo"},
          {"uri", "file:///repo/new.cpp"}, {"directory", false}},
          "create-file request was wrong");
    check(createDirectory.params.at("directory") == true, "create-directory request was wrong");
    check(rename.params.at("from") == "file:///repo/source.cpp" &&
          rename.params.at("to") == "file:///repo/main.cpp", "rename request was wrong");
    check(copy.params.at("recursive") == true, "directory copy was not recursive");
    check(remove.params.at("mode") == "trash", "remove did not default to recoverable trash");
    check(reveal.params.at("uri") == "file:///repo/include-copy", "reveal request was wrong");
}

void testSearchQuickOpenAndSourceOpen() {
    Fixture fixture;
    openWorkspace(fixture, "/repo", "workspace-repo", "repo");

    fixture.view.search("needle", SearchKind::Content, 37, true);
    auto search = fixture.transport.take("workspace.search");
    check(search.params.at("workspaceId") == "workspace-repo", "search omitted workspace id");
    check(search.params.at("query") == Json{{"text", "needle"}, {"kind", "content"},
          {"maxResults", 37}, {"includeIgnored", true}}, "search query request was wrong");
    fixture.respond(search, {{"results", Json::array({
        {{"uri", "file:///repo/source.cpp"}, {"line", 4}, {"column", 2},
         {"preview", "the needle"}, {"score", 0.9}}
    })}});
    check(!fixture.view.searchPending() && fixture.view.searchResults().size() == 1,
          "search response was not retained");
    check(fixture.view.searchResults().front().line == 4, "search location was lost");

    fixture.editorProbe.textByUri["file:///repo/source.cpp"] = "int needle;";
    check(fixture.view.openSource(fixture.view.searchResults().front().uri),
          "search result did not open as source");
    fixture.editor.processCallbacks();
    check(fixture.editor.activeUri() == "file:///repo/source.cpp",
          "EditorPanel did not activate the opened source");
    check(fixture.editorProbe.reads.back().workspaceId == "workspace-repo",
          "source read used a stale project id");

    fixture.view.quickOpen("source");
    auto quick = fixture.transport.take("workspace.search");
    check(quick.params.at("query").at("kind") == "files",
          "quick open did not use file search");
}

void testAgentExternalMotionAndEditorRefresh() {
    Fixture fixture;
    openWorkspace(fixture, "/repo", "workspace-repo", "repo", Json::array({
        entry("file:///repo/source.cpp", "source.cpp", "source.cpp")
    }));
    fixture.editorProbe.textByUri["file:///repo/source.cpp"] = "before\n";
    fixture.view.openSource("file:///repo/source.cpp");
    fixture.editor.processCallbacks();

    fixture.editorProbe.generation = 2;
    fixture.editorProbe.textByUri["file:///repo/source.cpp"] = "before\nafter\n";
    FileChange agentChange{FileChangeKind::Modified, "file:///repo/source.cpp", std::nullopt,
        FileStamp{"changed", 13, 2, 2}, ChangeOrigin::Agent};
    fixture.view.applyChanges("workspace-repo", {agentChange});
    fixture.editor.processCallbacks();

    const auto agentMotion = fixture.view.motion("file:///repo/source.cpp");
    check(agentMotion && agentMotion->origin == ChangeOrigin::Agent &&
          agentMotion->durationSeconds == anim::kSlow,
          "agent file change did not use the shared slow motion token");
    const auto* document = fixture.editor.document("file:///repo/source.cpp");
    check(document && document->text == "before\nafter\n" && document->flash.active,
          "agent file change did not refresh and animate the open editor");

    fixture.view.advanceAnimations(anim::kSlow + 0.01F);
    check(!fixture.view.motion("file:///repo/source.cpp"), "finished tree motion was not retired");

    FileChange externalChange{FileChangeKind::Created, "file:///repo/new.cpp", std::nullopt,
        std::nullopt, ChangeOrigin::External};
    fixture.view.applyChanges("workspace-repo", {externalChange});
    const auto externalMotion = fixture.view.motion("file:///repo/new.cpp");
    check(externalMotion && externalMotion->durationSeconds == anim::kBase,
          "external file change did not use the shared base motion token");
}

} // namespace

int main() {
    try {
        testProjectRecentSelectionAndMultiProjectState();
        testTreeBadgesAndFileActionRequests();
        testSearchQuickOpenAndSourceOpen();
        testAgentExternalMotionAndEditorRefresh();
        std::cout << "workspace tests passed\n";
        return EXIT_SUCCESS;
    } catch (const std::exception& exception) {
        std::cerr << "workspace test failure: " << exception.what() << '\n';
        return EXIT_FAILURE;
    }
}
