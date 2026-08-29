#include "workspace/workspace_view.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <imgui.h>

#include "editor/editor.h"
#include "protocol/desktop_client.h"
#include "protocol/desktop_store.h"
#include "theme/anim.h"
#include "theme/theme.h"
#include "widgets/kit.h"

namespace chud::workspace {
namespace {

const std::vector<WorkspaceEntry> kNoEntries;

std::string parentUri(std::string_view uri) {
    const auto slash = uri.find_last_of('/');
    if (slash == std::string_view::npos || slash <= std::string_view("file://").size()) {
        return std::string(uri);
    }
    return std::string(uri.substr(0, slash));
}

std::string encodeUriPart(std::string_view part) {
    static constexpr char digits[] = "0123456789ABCDEF";
    std::string result;
    result.reserve(part.size());
    for (const unsigned char c : part) {
        if (std::isalnum(c) != 0 || c == '-' || c == '_' || c == '.' || c == '~') {
            result.push_back(static_cast<char>(c));
        } else {
            result.push_back('%');
            result.push_back(digits[c >> 4U]);
            result.push_back(digits[c & 0x0FU]);
        }
    }
    return result;
}

std::string appendUri(std::string_view parent, std::string_view name) {
    std::string result(parent);
    while (!result.empty() && result.back() == '/') result.pop_back();
    result.push_back('/');
    result += encodeUriPart(name);
    return result;
}

std::string rootUriFor(std::string_view rootPath) {
    std::string normalized(rootPath);
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    while (normalized.size() > 1 && normalized.back() == '/') normalized.pop_back();
    std::string result = "file://";
    for (std::size_t i = 0; i < normalized.size();) {
        if (normalized[i] == '/') {
            result.push_back('/');
            ++i;
            continue;
        }
        const auto slash = normalized.find('/', i);
        result += encodeUriPart(std::string_view(normalized).substr(
            i, slash == std::string::npos ? normalized.size() - i : slash - i));
        if (slash == std::string::npos) break;
        i = slash;
    }
    return result;
}

std::string leafName(std::string_view uri) {
    const auto slash = uri.find_last_of('/');
    return std::string(slash == std::string_view::npos ? uri : uri.substr(slash + 1));
}

WorkspaceDescriptor parseWorkspace(const Json& value) {
    return {value.at("id").get<std::string>(), value.at("rootPath").get<std::string>(),
            value.at("displayName").get<std::string>()};
}

WorkspaceEntry parseEntry(const Json& value) {
    WorkspaceEntry entry;
    entry.uri = value.at("uri").get<std::string>();
    entry.name = value.at("name").get<std::string>();
    entry.relativePath = value.at("relativePath").get<std::string>();
    entry.directory = value.at("directory").get<bool>();
    entry.ignored = value.at("ignored").get<bool>();
    if (value.contains("stamp") && !value.at("stamp").is_null()) {
        const auto& stamp = value.at("stamp");
        entry.stamp = FileStamp{stamp.at("sha256").get<std::string>(),
                                stamp.at("size").get<std::int64_t>(),
                                stamp.at("mtimeNs").get<std::int64_t>(),
                                stamp.at("generation").get<std::int64_t>()};
    }
    return entry;
}

SearchResult parseSearchResult(const Json& value) {
    SearchResult result;
    result.uri = value.at("uri").get<std::string>();
    if (value.contains("line") && !value.at("line").is_null()) {
        result.line = value.at("line").get<std::int64_t>();
    }
    if (value.contains("column") && !value.at("column").is_null()) {
        result.column = value.at("column").get<std::int64_t>();
    }
    result.preview = value.at("preview").get<std::string>();
    if (value.contains("score") && !value.at("score").is_null()) {
        result.score = value.at("score").get<double>();
    }
    return result;
}

void sortEntries(std::vector<WorkspaceEntry>& entries) {
    std::sort(entries.begin(), entries.end(), [](const WorkspaceEntry& left,
                                                  const WorkspaceEntry& right) {
        if (left.directory != right.directory) return left.directory;
        std::string leftName = left.name;
        std::string rightName = right.name;
        std::transform(leftName.begin(), leftName.end(), leftName.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        std::transform(rightName.begin(), rightName.end(), rightName.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (leftName != rightName) return leftName < rightName;
        return left.name < right.name;
    });
}

const char* searchKindName(SearchKind kind) {
    switch (kind) {
    case SearchKind::Files: return "files";
    case SearchKind::Content: return "content";
    case SearchKind::Symbols: return "symbols";
    }
    return "files";
}

const char* deleteModeName(DeleteMode mode) {
    return mode == DeleteMode::Permanent ? "permanent" : "trash";
}

editor::ChangeOrigin editorOrigin(ChangeOrigin origin) {
    switch (origin) {
    case ChangeOrigin::Agent: return editor::ChangeOrigin::Agent;
    case ChangeOrigin::User: return editor::ChangeOrigin::User;
    case ChangeOrigin::External: return editor::ChangeOrigin::External;
    }
    return editor::ChangeOrigin::External;
}

std::optional<editor::FileStamp> editorStamp(const std::optional<FileStamp>& stamp) {
    if (!stamp) return std::nullopt;
    return editor::FileStamp{stamp->sha256, static_cast<std::uint64_t>(std::max<std::int64_t>(0, stamp->size)),
                             static_cast<std::uint64_t>(std::max<std::int64_t>(0, stamp->mtimeNs)),
                             static_cast<std::uint64_t>(std::max<std::int64_t>(0, stamp->generation))};
}

// The shell caps the side panel at min(px(286), width * 0.24), so its content
// region stays ~254px wide even on a 2560px monitor and a row of three or four
// framed controls never fits. Measuring what actually fits keeps the full
// labels whenever they do and lets the remainder fall onto another row, instead
// of abbreviating (or silently dropping) controls behind a fixed threshold.
float framedWidth(const char* label) {
    return ImGui::CalcTextSize(label).x + (ImGui::GetStyle().FramePadding.x * 2.0F);
}

struct FlowLabel {
    const char* label;  // what the control draws
    const char* full;   // the action name, for the hover hint when abbreviated
    bool compact;
};

class FlowRow {
  public:
    explicit FlowRow(float available)
        : available_(available), spacing_(ImGui::GetStyle().ItemSpacing.x) {}

    // Call immediately before submitting the control: it either keeps the
    // control on the current row or leaves it to start the next one.
    FlowLabel next(const char* full, const char* compact = nullptr) {
        const char* label = full;
        if (compact != nullptr && framedWidth(full) > available_) label = compact;
        const float width = framedWidth(label);
        if (placed_ && used_ + spacing_ + width <= available_) {
            ImGui::SameLine();
            used_ += spacing_ + width;
        } else {
            used_ = width;
        }
        placed_ = true;
        return {label, full, label != full};
    }

  private:
    float available_;
    float spacing_;
    float used_ = 0.0F;
    bool placed_ = false;
};

// An abbreviation is never self-explanatory, so name the action on hover.
void flowHint(const FlowLabel& item) {
    if (item.compact && ImGui::IsItemHovered()) ImGui::SetTooltip("%s", item.full);
}

} // namespace

struct WorkspaceView::Impl {
    struct ProjectState {
        WorkspaceDescriptor descriptor;
        std::unordered_map<std::string, std::vector<WorkspaceEntry>> entriesByParent;
        std::unordered_set<std::string> expanded;
        std::unordered_set<std::string> loading;
        std::unordered_set<std::string> reloadAfterLoading;
        std::string selected;
        std::vector<SearchResult> searchResults;
        SearchKind searchKind = SearchKind::Files;
        std::uint64_t searchGeneration = 0;
        bool searchPending = false;
        std::unordered_map<std::string, FileMotion> motions;
        std::vector<FileChange> lastStoreChanges;
        std::vector<FileChange> deferredEditorChanges;
        std::unordered_set<std::string> editorUris;
        std::string activeEditorUri;
    };
    struct EditorSession {
        std::vector<editor::DocumentState> documents;
        std::string activeUri;
    };


    struct CallbackGate { Impl* owner = nullptr; };
    enum class PendingAction { None, CreateFile, CreateDirectory, Rename, Copy };
    struct VisibleEntry { const WorkspaceEntry* entry = nullptr; int depth = 0; };

    DesktopClient& client;
    DesktopStore& store;
    editor::EditorPanel& editor;
    std::unordered_map<std::string, ProjectState> projects;
    std::string activeWorkspaceId;
    std::vector<RecentProject> recent;
    std::string error;
    std::shared_ptr<CallbackGate> callbackGate = std::make_shared<CallbackGate>();

    bool recentPending = false;
    bool recentRequested = false;
    bool projectPopupRequested = false;
    bool openPending = false;
    bool showSearch = false;
    bool focusSearch = false;
    bool projectChordPending = false;
    double projectChordStartedAt = 0.0;
    std::array<char, 512> searchBuffer{};

    PendingAction pendingAction = PendingAction::None;
    std::string pendingFrom;
    std::string pendingParent;
    std::array<char, 256> pendingName{};
    bool openActionPopup = false;

    Impl(DesktopClient& clientValue, DesktopStore& storeValue, editor::EditorPanel& editorValue)
        : client(clientValue), store(storeValue), editor(editorValue) {
        callbackGate->owner = this;
    }

    ~Impl() { callbackGate->owner = nullptr; }

    ProjectState* activeProject() noexcept {
        const auto found = projects.find(activeWorkspaceId);
        return found == projects.end() ? nullptr : &found->second;
    }
    const ProjectState* activeProject() const noexcept {
        const auto found = projects.find(activeWorkspaceId);
        return found == projects.end() ? nullptr : &found->second;
    }

    static void setBuffer(auto& buffer, std::string_view value) {
        const auto count = std::min(value.size(), buffer.size() - 1U);
        std::memcpy(buffer.data(), value.data(), count);
        buffer[count] = '\0';
    }

    void report(const ResponseFrame& response) {
        error = response.error ? response.error->message : "Desktop service returned an invalid response";
    }

    std::string requestKey(const ProjectState& project, std::string_view parent) const {
        if (parent.empty() || parent == rootUriFor(project.descriptor.rootPath)) return {};
        return std::string(parent);
    }

    std::string containingKey(const ProjectState& project, std::string_view uri) const {
        return requestKey(project, parentUri(uri));
    }

    void refreshTreeFor(const std::string& workspaceId, std::optional<std::string> parent) {
        const auto projectIt = projects.find(workspaceId);
        if (projectIt == projects.end()) return;
        auto& project = projectIt->second;
        const std::string key = requestKey(project, parent.value_or(std::string{}));
        if (!project.loading.insert(key).second) {
            project.reloadAfterLoading.insert(key);
            return;
        }

        Json params{{"workspaceId", workspaceId}};
        if (!key.empty()) params["uri"] = key;
        const std::weak_ptr<CallbackGate> weak = callbackGate;
        client.request("workspace.list", std::move(params),
            [weak, workspaceId, key](const ResponseFrame& response) {
                const auto gate = weak.lock();
                if (!gate || !gate->owner) return;
                auto& self = *gate->owner;
                const auto found = self.projects.find(workspaceId);
                if (found == self.projects.end()) return;
                auto& state = found->second;
                state.loading.erase(key);
                const bool reload = state.reloadAfterLoading.erase(key) != 0U;
                if (response.error || !response.result || !response.result->contains("entries") ||
                    !response.result->at("entries").is_array()) {
                    self.report(response);
                    if (reload) self.refreshTreeFor(workspaceId,
                        key.empty() ? std::nullopt : std::optional<std::string>(key));
                    return;
                }
                try {
                    std::vector<WorkspaceEntry> values;
                    values.reserve(response.result->at("entries").size());
                    for (const auto& value : response.result->at("entries")) values.push_back(parseEntry(value));
                    sortEntries(values);
                    state.entriesByParent[key] = std::move(values);
                    self.error.clear();
                } catch (const std::exception& exception) {
                    self.error = exception.what();
                }
                if (reload) self.refreshTreeFor(workspaceId,
                    key.empty() ? std::nullopt : std::optional<std::string>(key));
            });
    }

    EditorSession captureEditorSession() const {
        EditorSession session;
        session.documents.reserve(editor.tabs().size());
        for (const auto& uri : editor.tabs()) {
            if (const auto* document = editor.document(uri)) {
                session.documents.push_back(*document);
            }
        }
        session.activeUri = editor.activeUri();
        return session;
    }

    void setEditorWorkspace(std::string workspaceId) {
        if (editor.workspace() == workspaceId) return;

        // EditorPanel owns the shared tab/session set, but its workspace setter
        // clears that set. Rehydrate it while changing the request-routing id.
        const auto session = captureEditorSession();
        editor.setWorkspace(std::move(workspaceId));
        for (const auto& document : session.documents) {
            editor.acceptSnapshot({document.id, document.uri, document.language,
                                   document.baseText, document.stamp}, false);
            // No TextEditor instances exist after setWorkspace(), so restoring
            // the complete state here also preserves dirty/conflict/view state
            // before the widgets are lazily recreated.
            if (auto* restored = editor.document(document.uri)) *restored = document;
        }
        if (!session.activeUri.empty()) (void)editor.activate(session.activeUri);
    }

    void activate(WorkspaceDescriptor descriptor) {
        if (auto* current = activeProject()) {
            const std::string activeUri(editor.activeUri());
            if (current->editorUris.contains(activeUri)) current->activeEditorUri = activeUri;
        }

        const std::string id = descriptor.id;
        auto [iterator, inserted] = projects.try_emplace(id);
        auto& project = iterator->second;
        if (!inserted && project.descriptor.rootPath != descriptor.rootPath) {
            project = ProjectState{};
        }
        project.descriptor = std::move(descriptor);
        activeWorkspaceId = id;
        setEditorWorkspace(id);
        if (!project.activeEditorUri.empty()) (void)editor.activate(project.activeEditorUri);
        if (!project.deferredEditorChanges.empty()) {
            const auto deferred = std::move(project.deferredEditorChanges);
            project.deferredEditorChanges.clear();
            notifyEditor(deferred);
        }
        if (!project.entriesByParent.contains("") && !project.loading.contains("")) {
            refreshTreeFor(id, std::nullopt);
        }
    }

    void notifyEditor(const std::vector<FileChange>& changes) {
        for (const auto& change : changes) {
            if (change.kind == FileChangeKind::Renamed && change.oldUri) {
                if (auto* oldDocument = editor.document(*change.oldUri)) {
                    if (!oldDocument->dirty && editor.close(*change.oldUri, false)) {
                        editor.open(change.uri);
                    } else {
                        editor.fileChanged(*change.oldUri, editorOrigin(change.origin), std::nullopt);
                    }
                }
                continue;
            }
            editor.fileChanged(change.uri, editorOrigin(change.origin), editorStamp(change.stamp));
        }
    }

    void refreshChangedParents(const std::string& workspaceId, const std::vector<FileChange>& changes) {
        auto found = projects.find(workspaceId);
        if (found == projects.end()) return;
        auto& project = found->second;
        bool rescan = false;
        std::unordered_set<std::string> keys;
        for (const auto& change : changes) {
            if (change.kind == FileChangeKind::RescanRequired) {
                rescan = true;
                break;
            }
            keys.insert(containingKey(project, change.uri));
            if (change.oldUri) keys.insert(containingKey(project, *change.oldUri));
        }
        if (rescan) {
            std::vector<std::string> loaded;
            loaded.reserve(project.entriesByParent.size());
            for (const auto& [key, ignored] : project.entriesByParent) {
                (void)ignored;
                loaded.push_back(key);
            }
            for (const auto& key : loaded) refreshTreeFor(workspaceId, key.empty() ? std::nullopt : std::optional<std::string>(key));
            return;
        }
        for (const auto& key : keys) {
            if (project.entriesByParent.contains(key)) {
                refreshTreeFor(workspaceId, key.empty() ? std::nullopt : std::optional<std::string>(key));
            }
        }
    }

    void sendAction(std::string method, Json params, std::vector<std::string> refreshKeys,
                    std::optional<std::string> clearSelection = std::nullopt) {
        const std::string workspaceId = activeWorkspaceId;
        const std::weak_ptr<CallbackGate> weak = callbackGate;
        client.request(std::move(method), std::move(params),
            [weak, workspaceId, refreshKeys = std::move(refreshKeys),
             clearSelection = std::move(clearSelection)](const ResponseFrame& response) mutable {
                const auto gate = weak.lock();
                if (!gate || !gate->owner) return;
                auto& self = *gate->owner;
                if (response.error || !response.result) {
                    self.report(response);
                    return;
                }
                auto found = self.projects.find(workspaceId);
                if (found == self.projects.end()) return;
                if (clearSelection && found->second.selected == *clearSelection) found->second.selected.clear();
                self.error.clear();
                std::sort(refreshKeys.begin(), refreshKeys.end());
                refreshKeys.erase(std::unique(refreshKeys.begin(), refreshKeys.end()), refreshKeys.end());
                for (const auto& key : refreshKeys) {
                    self.refreshTreeFor(workspaceId,
                        key.empty() ? std::nullopt : std::optional<std::string>(key));
                }
            });
    }

    std::string gitBadge(const WorkspaceEntry& entry) const {
        const auto* project = activeProject();
        if (!project) return {};
        const auto* snapshot = store.workspace(project->descriptor.id);
        if (!snapshot || !snapshot->git) return {};
        for (const auto& file : snapshot->git->files) {
            if (file.path != entry.relativePath) continue;
            if (file.untracked) return "U";
            std::string badge;
            if (!file.staged.empty()) badge += file.staged.front();
            if (!file.unstaged.empty()) {
                if (!badge.empty()) badge.push_back('/');
                badge += file.unstaged.front();
            }
            return badge;
        }
        return {};
    }

    void collectVisible(const ProjectState& project, std::string_view parent, int depth,
                        std::vector<VisibleEntry>& out) const {
        const auto found = project.entriesByParent.find(std::string(parent));
        if (found == project.entriesByParent.end()) return;
        for (const auto& entry : found->second) {
            out.push_back({&entry, depth});
            if (entry.directory && project.expanded.contains(entry.uri)) {
                collectVisible(project, entry.uri, depth + 1, out);
            }
        }
    }
    void keyboardNavigate(std::vector<VisibleEntry>& visible) {
        auto* project = activeProject();
        if (!project || visible.empty() || ImGui::GetIO().WantTextInput ||
            !ImGui::IsWindowFocused(ImGuiFocusedFlags_ChildWindows)) return;
        auto selected = std::find_if(visible.begin(), visible.end(), [&](const VisibleEntry& item) {
            return item.entry->uri == project->selected;
        });
        std::size_t index = selected == visible.end() ? 0U : static_cast<std::size_t>(selected - visible.begin());
        if (ImGui::IsKeyPressed(ImGuiKey_DownArrow)) {
            index = selected == visible.end() ? 0U : std::min(index + 1U, visible.size() - 1U);
            project->selected = visible[index].entry->uri;
        } else if (ImGui::IsKeyPressed(ImGuiKey_UpArrow)) {
            index = selected == visible.end() ? 0U : (index == 0U ? 0U : index - 1U);
            project->selected = visible[index].entry->uri;
        } else if (selected != visible.end() && ImGui::IsKeyPressed(ImGuiKey_RightArrow)) {
            if (visible[index].entry->directory) {
                setExpanded(visible[index].entry->uri, true);
            }
        } else if (selected != visible.end() && ImGui::IsKeyPressed(ImGuiKey_LeftArrow)) {
            const auto& entry = *visible[index].entry;
            if (entry.directory && project->expanded.contains(entry.uri)) {
                project->expanded.erase(entry.uri);
            } else {
                const auto parent = parentUri(entry.uri);
                const auto parentItem = std::find_if(visible.begin(), visible.end(), [&](const VisibleEntry& item) {
                    return item.entry->uri == parent;
                });
                if (parentItem != visible.end()) project->selected = parent;
            }
        } else if (selected != visible.end() && ImGui::IsKeyPressed(ImGuiKey_Enter)) {
            const auto& entry = *visible[index].entry;
            if (entry.directory) toggleExpanded(entry.uri);
            else openSource(entry.uri);
        }
    }

    void beginPending(PendingAction action, const WorkspaceEntry* entry) {
        auto* project = activeProject();
        if (!project) return;
        pendingAction = action;
        pendingFrom = entry ? entry->uri : std::string{};
        if (action == PendingAction::CreateFile || action == PendingAction::CreateDirectory) {
            if (entry && entry->directory) pendingParent = entry->uri;
            else if (entry) pendingParent = containingKey(*project, entry->uri);
            else pendingParent = rootUriFor(project->descriptor.rootPath);
            setBuffer(pendingName, {});
        } else if (entry) {
            pendingParent = parentUri(entry->uri);
            setBuffer(pendingName, entry->name);
        }
        openActionPopup = true;
    }

    void submitPending() {
        const std::string name(pendingName.data());
        if (name.empty() || activeWorkspaceId.empty()) return;
        if (pendingAction == PendingAction::CreateFile || pendingAction == PendingAction::CreateDirectory) {
            create(appendUri(pendingParent, name), pendingAction == PendingAction::CreateDirectory);
        } else if (pendingAction == PendingAction::Rename) {
            rename(pendingFrom, appendUri(pendingParent, name));
        } else if (pendingAction == PendingAction::Copy) {
            bool recursive = false;
            if (const auto* project = activeProject()) {
                for (const auto& [parent, children] : project->entriesByParent) {
                    (void)parent;
                    const auto found = std::find_if(children.begin(), children.end(), [&](const WorkspaceEntry& entry) {
                        return entry.uri == pendingFrom;
                    });
                    if (found != children.end()) { recursive = found->directory; break; }
                }
            }
            copy(pendingFrom, appendUri(pendingParent, name), recursive);
        }
        pendingAction = PendingAction::None;
        pendingFrom.clear();
        pendingParent.clear();
        pendingName[0] = '\0';
    }

    void drawPendingPopup() {
        if (openActionPopup) {
            ImGui::OpenPopup("File action##workspace");
            openActionPopup = false;
        }
        if (!ImGui::BeginPopupModal("File action##workspace", nullptr,
                                    ImGuiWindowFlags_AlwaysAutoResize)) return;
        const char* title = "Name";
        switch (pendingAction) {
        case PendingAction::CreateFile: title = "Create file"; break;
        case PendingAction::CreateDirectory: title = "Create folder"; break;
        case PendingAction::Rename: title = "Rename"; break;
        case PendingAction::Copy: title = "Copy as"; break;
        case PendingAction::None: break;
        }
        ImGui::TextUnformatted(title);
        ImGui::SetNextItemWidth(320.0F);
        const bool submitted = ImGui::InputText("##workspace-file-name", pendingName.data(), pendingName.size(),
                                                ImGuiInputTextFlags_EnterReturnsTrue);
        const bool valid = pendingName[0] != '\0';
        if ((kit::primaryButton("Apply", {}, valid) || submitted) && valid) {
            submitPending();
            ImGui::CloseCurrentPopup();
        }
        ImGui::SameLine();
        if (kit::secondaryButton("Cancel")) {
            pendingAction = PendingAction::None;
            ImGui::CloseCurrentPopup();
        }
        ImGui::EndPopup();
    }

    void drawContextMenu(const WorkspaceEntry& entry) {
        if (!ImGui::BeginPopupContextItem()) return;
        auto* project = activeProject();
        if (project) project->selected = entry.uri;
        if (ImGui::MenuItem("Open", "Enter", false, !entry.directory)) openSource(entry.uri);
        if (entry.directory && ImGui::MenuItem(project && project->expanded.contains(entry.uri) ? "Collapse" : "Expand")) {
            toggleExpanded(entry.uri);
        }
        ImGui::Separator();
        if (ImGui::MenuItem("New File")) beginPending(PendingAction::CreateFile, &entry);
        if (ImGui::MenuItem("New Folder")) beginPending(PendingAction::CreateDirectory, &entry);
        if (ImGui::MenuItem("Rename")) beginPending(PendingAction::Rename, &entry);
        if (ImGui::MenuItem("Copy")) beginPending(PendingAction::Copy, &entry);
        ImGui::Separator();
        if (ImGui::MenuItem("Reveal in File Manager")) reveal(entry.uri);
        if (ImGui::MenuItem("Move to Trash")) remove(entry.uri, DeleteMode::Trash);
        ImGui::EndPopup();
    }

    void drawTree() {
        auto* project = activeProject();
        if (!project) {
            (void)kit::emptyState("No project open", "Choose Open Folder or a recent project.");
            return;
        }

        // Flow the toolbar on measured widths. The previous `available < 280`
        // test passed at every resolution, which permanently abbreviated these
        // labels and removed Refresh entirely.
        FlowRow toolbar(ImGui::GetContentRegionAvail().x);
        const FlowLabel quickOpen = toolbar.next("Quick Open", "Find");
        if (kit::secondaryButton(quickOpen.label, {}, true)) {
            showSearch = true;
            focusSearch = true;
            project->searchKind = SearchKind::Files;
            searchBuffer[0] = '\0';
        }
        flowHint(quickOpen);
        const FlowLabel newFile = toolbar.next("New File", "+F");
        if (kit::secondaryButton(newFile.label)) beginPending(PendingAction::CreateFile, nullptr);
        flowHint(newFile);
        const FlowLabel newFolder = toolbar.next("New Folder", "+D");
        if (kit::secondaryButton(newFolder.label)) beginPending(PendingAction::CreateDirectory, nullptr);
        flowHint(newFolder);
        const FlowLabel refresh = toolbar.next("Refresh", "Sync");
        if (kit::secondaryButton(refresh.label)) refreshTree();
        flowHint(refresh);

        std::vector<VisibleEntry> visible;
        collectVisible(*project, "", 0, visible);
        if (project->loading.contains("") && visible.empty()) {
            kit::spinner("Loading files");
            return;
        }
        if (visible.empty()) {
            if (kit::emptyState("This project is empty", "Create a file or refresh the workspace.", "Refresh")) refreshTree();
            return;
        }

        keyboardNavigate(visible);
        ImGui::PushID(project->descriptor.id.c_str());
        for (const auto& visibleEntry : visible) {
            const auto& entry = *visibleEntry.entry;
            ImGui::PushID(entry.uri.c_str());
            if (visibleEntry.depth > 0) ImGui::Indent(static_cast<float>(visibleEntry.depth) * 14.0F);

            // The tree column never exceeds px(286) at any resolution, so a long
            // name has to elide here rather than wait for width. The secondary
            // tags are painted after the row so they can carry their own colour
            // without joining the selectable's label.
            std::string head = entry.directory
                ? (project->expanded.contains(entry.uri) ? "v " : "> ")
                : "  ";
            head += entry.name;
            std::string ignoredTag;
            if (entry.ignored) ignoredTag = "  [ignored]";
            std::string badgeTag;
            const auto badge = gitBadge(entry);
            if (!badge.empty()) badgeTag = "  [" + badge + "]";

            const float tagWidth =
                ignoredTag.empty() ? 0.0F : ImGui::CalcTextSize(ignoredTag.c_str()).x;
            const float badgeWidth =
                badgeTag.empty() ? 0.0F : ImGui::CalcTextSize(badgeTag.c_str()).x;
            const float nameBudget = ImGui::GetContentRegionAvail().x - tagWidth - badgeWidth -
                                     ImGui::GetStyle().ItemSpacing.x;
            const std::string shown = kit::elide(head, nameBudget);
            const bool elided = shown != head;
            const float nameWidth = ImGui::CalcTextSize(shown.c_str()).x;
            // "###" seeds the id from the uri alone, so eliding the visible name
            // (or a tag appearing) does not drop hover/selection state on resize.
            const std::string label = shown + "###" + entry.uri;
            const ImVec2 rowTextPos = ImGui::GetCursorScreenPos();

            float motionAmount = 0.0F;
            const auto moving = project->motions.find(entry.uri);
            if (moving != project->motions.end()) {
                const ImGuiID animationId = ImGui::GetID("file-change-motion");
                motionAmount = anim::toward(animationId,
                    moving->second.remainingSeconds > 0.0F ? 1.0F : 0.0F,
                    moving->second.durationSeconds);
                if (moving->second.remainingSeconds > 0.0F) anim::requestFrames();
            }
            if (motionAmount > 0.001F) {
                const ImVec4 wash = moving->second.origin == ChangeOrigin::Agent
                    ? ui::palette().accentSoft : ui::palette().statusInfoWash;
                ImGui::PushStyleColor(ImGuiCol_Header, ui::mix(ui::palette().panelBg, wash, motionAmount));
                ImGui::PushStyleColor(ImGuiCol_HeaderHovered, ui::mix(ui::palette().buttonHovered, wash, motionAmount));
            }
            const bool selected = project->selected == entry.uri;
            if (ImGui::Selectable(label.c_str(), selected, ImGuiSelectableFlags_AllowDoubleClick)) {
                project->selected = entry.uri;
                if (ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left)) {
                    if (entry.directory) toggleExpanded(entry.uri);
                    else openSource(entry.uri);
                }
            }
            if (motionAmount > 0.001F) ImGui::PopStyleColor(2);
            const bool hasTags = !ignoredTag.empty() || !badgeTag.empty();
            if (hasTags && ImGui::IsItemVisible()) {
                ImDrawList* drawList = ImGui::GetWindowDrawList();
                float tagX = rowTextPos.x + nameWidth;
                if (!ignoredTag.empty()) {
                    // Secondary colour so a tagged entry reads as de-emphasised.
                    drawList->AddText(ImVec2(tagX, rowTextPos.y),
                                      ui::toU32(ui::palette().textDim), ignoredTag.c_str());
                    tagX += tagWidth;
                }
                if (!badgeTag.empty()) {
                    drawList->AddText(ImVec2(tagX, rowTextPos.y),
                                      ui::toU32(ui::palette().text), badgeTag.c_str());
                }
            }
            if (ImGui::IsItemHovered()) {
                if (!entry.relativePath.empty()) {
                    ImGui::SetTooltip("%s", entry.relativePath.c_str());
                } else if (elided) {
                    ImGui::SetTooltip("%s", entry.name.c_str());
                }
            }
            drawContextMenu(entry);
            if (visibleEntry.depth > 0) ImGui::Unindent(static_cast<float>(visibleEntry.depth) * 14.0F);
            ImGui::PopID();
        }
        ImGui::PopID();
    }

    void drawSearchPanel() {
        auto* project = activeProject();
        if (!project || !showSearch) return;
        kit::rule();
        if (focusSearch) {
            ImGui::SetKeyboardFocusHere();
            focusSearch = false;
        }
        ImGui::SetNextItemWidth(-1.0F);
        const bool submit = ImGui::InputTextWithHint("##workspace-search", "Search project...",
            searchBuffer.data(), searchBuffer.size(), ImGuiInputTextFlags_EnterReturnsTrue);
        // Four small buttons overflow ~250px, which clipped "Symbols" mid-glyph;
        // flow them so every filter stays fully readable.
        FlowRow filters(ImGui::GetContentRegionAvail().x);
        if (ImGui::SmallButton(filters.next("Files").label)) project->searchKind = SearchKind::Files;
        if (ImGui::SmallButton(filters.next("Content").label)) project->searchKind = SearchKind::Content;
        if (ImGui::SmallButton(filters.next("Symbols").label)) project->searchKind = SearchKind::Symbols;
        if (ImGui::SmallButton(filters.next("Close").label)) showSearch = false;
        if (submit && searchBuffer[0] != '\0') search(searchBuffer.data(), project->searchKind, 200, false);
        if (project->searchPending) kit::spinner("Searching");
        for (const auto& result : project->searchResults) {
            std::string title = leafName(result.uri);
            if (result.line) title += ":" + std::to_string(*result.line + 1);
            kit::RowStyle style;
            style.secondary = result.preview.c_str();
            style.tooltip = result.uri.c_str();
            const std::string id = "##search-" + result.uri + "-" +
                std::to_string(result.line.value_or(-1));
            if (kit::row(id.c_str(), title.c_str(), style)) {
                openSource(result.uri);
                showSearch = false;
            }
        }
        kit::rule();
    }

    void handleShortcuts() {
        const ImGuiIO& io = ImGui::GetIO();
        const bool command = io.KeyCtrl || io.KeySuper;
        if (command && !io.KeyAlt && ImGui::IsKeyPressed(ImGuiKey_K, false)) {
            projectChordPending = true;
            projectChordStartedAt = ImGui::GetTime();
        }
        if (projectChordPending && ImGui::GetTime() - projectChordStartedAt > 1.5) {
            projectChordPending = false;
        }
        if (projectChordPending && !command && !io.KeyShift && ImGui::IsKeyPressed(ImGuiKey_P, false)) {
            projectChordPending = false;
            projectPopupRequested = true;
            recentRequested = false;
        }
        if (command && !io.KeyAlt && ImGui::IsKeyPressed(ImGuiKey_P, false)) {
            showSearch = true;
            focusSearch = true;
            if (auto* project = activeProject()) project->searchKind = SearchKind::Files;
            searchBuffer[0] = '\0';
        }
        if (command && io.KeyShift && !io.KeyAlt && ImGui::IsKeyPressed(ImGuiKey_F, false)) {
            showSearch = true;
            focusSearch = true;
            if (auto* project = activeProject()) project->searchKind = SearchKind::Content;
        }
        if (ImGui::IsKeyPressed(ImGuiKey_Escape, false)) showSearch = false;
    }

    // Public wrappers used internally without a second pointer indirection.
    void setExpanded(std::string uri, bool expandedValue) {
        auto* project = activeProject();
        if (!project || uri.empty()) return;
        if (expandedValue) {
            project->expanded.insert(uri);
            if (!project->entriesByParent.contains(uri)) refreshTreeFor(activeWorkspaceId, uri);
        } else {
            project->expanded.erase(uri);
        }
    }
    void toggleExpanded(std::string uri) {
        const auto* project = activeProject();
        setExpanded(uri, !project || !project->expanded.contains(uri));
    }
    bool openSource(std::string uri) {
        auto* project = activeProject();
        if (!project || uri.empty()) return false;
        project->editorUris.insert(uri);
        project->activeEditorUri = uri;
        setEditorWorkspace(activeWorkspaceId);
        editor.open(std::move(uri));
        return true;
    }
    void refreshTree() { refreshTreeFor(activeWorkspaceId, std::nullopt); }
    void create(std::string uri, bool directory) {
        auto* project = activeProject();
        if (!project || uri.empty()) return;
        const std::string key = containingKey(*project, uri);
        sendAction("workspace.create", {{"workspaceId", activeWorkspaceId}, {"uri", std::move(uri)},
                    {"directory", directory}}, {key});
    }
    void rename(std::string from, std::string to) {
        auto* project = activeProject();
        if (!project || from.empty() || to.empty()) return;
        const std::string sourceKey = containingKey(*project, from);
        const std::string destinationKey = containingKey(*project, to);
        sendAction("workspace.rename", {{"workspaceId", activeWorkspaceId}, {"from", from},
                    {"to", std::move(to)}}, {sourceKey, destinationKey}, from);
    }
    void copy(std::string from, std::string to, bool recursive) {
        auto* project = activeProject();
        if (!project || from.empty() || to.empty()) return;
        const std::string destinationKey = containingKey(*project, to);
        sendAction("workspace.copy", {{"workspaceId", activeWorkspaceId}, {"from", std::move(from)},
                    {"to", std::move(to)}, {"recursive", recursive}}, {destinationKey});
    }
    void remove(std::string uri, DeleteMode mode) {
        auto* project = activeProject();
        if (!project || uri.empty()) return;
        const std::string key = containingKey(*project, uri);
        const std::string selection = uri;
        sendAction("workspace.remove", {{"workspaceId", activeWorkspaceId}, {"uri", std::move(uri)},
                    {"mode", deleteModeName(mode)}}, {key}, selection);
    }
    void reveal(std::string uri) {
        if (activeWorkspaceId.empty() || uri.empty()) return;
        const std::weak_ptr<CallbackGate> weak = callbackGate;
        client.request("workspace.reveal", {{"workspaceId", activeWorkspaceId}, {"uri", std::move(uri)}},
            [weak](const ResponseFrame& response) {
                const auto gate = weak.lock();
                if (!gate || !gate->owner) return;
                if (response.error || !response.result) gate->owner->report(response);
                else gate->owner->error.clear();
            });
    }
    void search(std::string text, SearchKind kind, std::int64_t maxResults, bool includeIgnored) {
        auto* project = activeProject();
        if (!project || text.empty()) return;
        project->searchPending = true;
        project->searchKind = kind;
        const std::uint64_t generation = ++project->searchGeneration;
        const std::string workspaceId = activeWorkspaceId;
        const std::weak_ptr<CallbackGate> weak = callbackGate;
        client.request("workspace.search", {{"workspaceId", workspaceId}, {"query", {
                {"text", std::move(text)}, {"kind", searchKindName(kind)},
                {"maxResults", maxResults}, {"includeIgnored", includeIgnored}}}},
            [weak, workspaceId, generation](const ResponseFrame& response) {
                const auto gate = weak.lock();
                if (!gate || !gate->owner) return;
                auto& self = *gate->owner;
                auto found = self.projects.find(workspaceId);
                if (found == self.projects.end() ||
                    found->second.searchGeneration != generation) return;
                found->second.searchPending = false;
                if (response.error || !response.result || !response.result->contains("results") ||
                    !response.result->at("results").is_array()) {
                    self.report(response);
                    return;
                }
                try {
                    std::vector<SearchResult> results;
                    results.reserve(response.result->at("results").size());
                    for (const auto& value : response.result->at("results")) {
                        results.push_back(parseSearchResult(value));
                    }
                    found->second.searchResults = std::move(results);
                    self.error.clear();
                } catch (const std::exception& exception) {
                    self.error = exception.what();
                }
            });
    }
};

WorkspaceView::WorkspaceView(DesktopClient& client, DesktopStore& store, editor::EditorPanel& editor)
    : impl_(std::make_unique<Impl>(client, store, editor)) {}
WorkspaceView::~WorkspaceView() = default;
WorkspaceView::WorkspaceView(WorkspaceView&&) noexcept = default;
WorkspaceView& WorkspaceView::operator=(WorkspaceView&&) noexcept = default;

void WorkspaceView::openProject(std::string rootPath) {
    if (rootPath.empty()) return;
    impl_->openPending = true;
    const std::weak_ptr<Impl::CallbackGate> weak = impl_->callbackGate;
    impl_->client.request("workspace.open", {{"rootPath", std::move(rootPath)}},
        [weak](const ResponseFrame& response) {
            const auto gate = weak.lock();
            if (!gate || !gate->owner) return;
            auto& self = *gate->owner;
            self.openPending = false;
            if (response.error || !response.result || !response.result->contains("workspace")) {
                self.report(response);
                return;
            }
            try {
                self.activate(parseWorkspace(response.result->at("workspace")));
                self.error.clear();
                self.recentRequested = false;
            } catch (const std::exception& exception) {
                self.error = exception.what();
            }
        });
}

void WorkspaceView::requestOpenFolder() {
    if (impl_->openPending) return;
    impl_->openPending = true;
    Json params = Json::object();
    if (const auto* project = impl_->activeProject()) params["initialPath"] = project->descriptor.rootPath;
    const std::weak_ptr<Impl::CallbackGate> weak = impl_->callbackGate;
    impl_->client.request("workspace.pick", std::move(params),
        [weak](const ResponseFrame& response) {
            const auto gate = weak.lock();
            if (!gate || !gate->owner) return;
            auto& self = *gate->owner;
            self.openPending = false;
            if (response.error || !response.result) {
                self.report(response);
                return;
            }
            const auto& result = *response.result;
            if (!result.value("cancelled", true) && result.contains("rootPath") && !result.at("rootPath").is_null()) {
                const std::string path = result.at("rootPath").get<std::string>();
                if (!path.empty()) {
                    self.openPending = true;
                    const std::weak_ptr<Impl::CallbackGate> openWeak = self.callbackGate;
                    self.client.request("workspace.open", {{"rootPath", path}},
                        [openWeak](const ResponseFrame& openResponse) {
                            const auto openGate = openWeak.lock();
                            if (!openGate || !openGate->owner) return;
                            auto& owner = *openGate->owner;
                            owner.openPending = false;
                            if (openResponse.error || !openResponse.result ||
                                !openResponse.result->contains("workspace")) {
                                owner.report(openResponse);
                                return;
                            }
                            try {
                                owner.activate(parseWorkspace(openResponse.result->at("workspace")));
                                owner.error.clear();
                                owner.recentRequested = false;
                            } catch (const std::exception& exception) {
                                owner.error = exception.what();
                            }
                        });
                }
            }
        });
}

void WorkspaceView::refreshRecent() {
    if (impl_->recentPending) return;
    impl_->recentPending = true;
    impl_->recentRequested = true;
    const std::weak_ptr<Impl::CallbackGate> weak = impl_->callbackGate;
    impl_->client.request("workspace.recent", Json::object(),
        [weak](const ResponseFrame& response) {
            const auto gate = weak.lock();
            if (!gate || !gate->owner) return;
            auto& self = *gate->owner;
            self.recentPending = false;
            if (response.error || !response.result || !response.result->contains("projects") ||
                !response.result->at("projects").is_array()) {
                self.report(response);
                return;
            }
            try {
                std::vector<RecentProject> projects;
                projects.reserve(response.result->at("projects").size());
                for (const auto& value : response.result->at("projects")) {
                    projects.push_back({value.at("rootPath").get<std::string>(),
                                        value.at("displayName").get<std::string>(),
                                        value.at("lastOpenedMs").get<std::int64_t>()});
                }
                std::sort(projects.begin(), projects.end(), [](const RecentProject& left,
                                                               const RecentProject& right) {
                    return left.lastOpenedMs > right.lastOpenedMs;
                });
                self.recent = std::move(projects);
                self.error.clear();
            } catch (const std::exception& exception) {
                self.error = exception.what();
            }
        });
}

void WorkspaceView::setWorkspace(WorkspaceDescriptor workspace) { impl_->activate(std::move(workspace)); }
const std::string& WorkspaceView::workspaceId() const noexcept { return impl_->activeWorkspaceId; }
const std::string& WorkspaceView::rootPath() const noexcept {
    static const std::string empty;
    const auto* project = impl_->activeProject();
    return project ? project->descriptor.rootPath : empty;
}
const WorkspaceDescriptor* WorkspaceView::currentWorkspace() const noexcept {
    const auto* project = impl_->activeProject();
    return project ? &project->descriptor : nullptr;
}
const std::vector<RecentProject>& WorkspaceView::recentProjects() const noexcept { return impl_->recent; }
std::size_t WorkspaceView::projectStateCount() const noexcept { return impl_->projects.size(); }

void WorkspaceView::refreshTree(std::optional<DocumentUri> parentUri) {
    impl_->refreshTreeFor(impl_->activeWorkspaceId, std::move(parentUri));
}
void WorkspaceView::setExpanded(std::string uri, bool expanded) { impl_->setExpanded(std::move(uri), expanded); }
void WorkspaceView::toggleExpanded(std::string uri) { impl_->toggleExpanded(std::move(uri)); }
bool WorkspaceView::isExpanded(std::string_view uri) const noexcept {
    const auto* project = impl_->activeProject();
    return project && project->expanded.contains(std::string(uri));
}
void WorkspaceView::select(std::string uri) {
    if (auto* project = impl_->activeProject()) project->selected = std::move(uri);
}
std::string_view WorkspaceView::selectedUri() const noexcept {
    const auto* project = impl_->activeProject();
    return project ? std::string_view(project->selected) : std::string_view{};
}
const std::vector<WorkspaceEntry>& WorkspaceView::entries(std::string_view parentUriValue) const noexcept {
    const auto* project = impl_->activeProject();
    if (!project) return kNoEntries;
    const auto found = project->entriesByParent.find(std::string(parentUriValue));
    return found == project->entriesByParent.end() ? kNoEntries : found->second;
}

bool WorkspaceView::isIgnored(std::string_view uri) const noexcept {
    const auto* project = impl_->activeProject();
    if (!project) return false;
    for (const auto& [parent, children] : project->entriesByParent) {
        (void)parent;
        const auto found = std::find_if(children.begin(), children.end(),
            [&](const WorkspaceEntry& entry) { return entry.uri == uri; });
        if (found != children.end()) return found->ignored;
    }
    return false;
}

std::string WorkspaceView::statusBadge(std::string_view uri) const {
    const auto* project = impl_->activeProject();
    if (!project) return {};
    for (const auto& [parent, children] : project->entriesByParent) {
        (void)parent;
        const auto found = std::find_if(children.begin(), children.end(),
            [&](const WorkspaceEntry& entry) { return entry.uri == uri; });
        if (found != children.end()) return impl_->gitBadge(*found);
    }
    return {};
}

void WorkspaceView::create(std::string uri, bool directory) { impl_->create(std::move(uri), directory); }
void WorkspaceView::rename(std::string from, std::string to) { impl_->rename(std::move(from), std::move(to)); }
void WorkspaceView::copy(std::string from, std::string to, bool recursive) {
    impl_->copy(std::move(from), std::move(to), recursive);
}
void WorkspaceView::remove(std::string uri, DeleteMode mode) { impl_->remove(std::move(uri), mode); }
void WorkspaceView::reveal(std::string uri) { impl_->reveal(std::move(uri)); }

void WorkspaceView::search(std::string text, SearchKind kind, std::int64_t maxResults, bool includeIgnored) {
    Impl::setBuffer(impl_->searchBuffer, text);
    impl_->search(std::move(text), kind, maxResults, includeIgnored);
}
void WorkspaceView::quickOpen(std::string text) {
    impl_->showSearch = true;
    impl_->focusSearch = true;
    if (auto* project = impl_->activeProject()) project->searchKind = SearchKind::Files;
    Impl::setBuffer(impl_->searchBuffer, text);
    if (!text.empty()) impl_->search(std::move(text), SearchKind::Files, 100, false);
}
const std::vector<SearchResult>& WorkspaceView::searchResults() const noexcept {
    static const std::vector<SearchResult> empty;
    const auto* project = impl_->activeProject();
    return project ? project->searchResults : empty;
}
SearchKind WorkspaceView::searchKind() const noexcept {
    const auto* project = impl_->activeProject();
    return project ? project->searchKind : SearchKind::Files;
}
bool WorkspaceView::searchPending() const noexcept {
    const auto* project = impl_->activeProject();
    return project && project->searchPending;
}
bool WorkspaceView::openSource(std::string uri) { return impl_->openSource(std::move(uri)); }

void WorkspaceView::applyChanges(std::string_view workspaceId, const std::vector<FileChange>& changes) {
    const auto found = impl_->projects.find(std::string(workspaceId));
    if (found == impl_->projects.end() || changes.empty()) return;
    auto& project = found->second;
    for (const auto& change : changes) {
        if (change.origin == ChangeOrigin::User) continue;
        const float duration = change.origin == ChangeOrigin::Agent ? anim::kSlow : anim::kBase;
        project.motions[change.uri] = FileMotion{change.kind, change.origin, duration, duration};
        if (change.oldUri) project.motions[*change.oldUri] = FileMotion{change.kind, change.origin, duration, duration};
        anim::requestFrames(duration);
    }
    if (workspaceId == impl_->activeWorkspaceId) impl_->notifyEditor(changes);
    else project.deferredEditorChanges.insert(project.deferredEditorChanges.end(), changes.begin(), changes.end());
    impl_->refreshChangedParents(std::string(workspaceId), changes);
}

void WorkspaceView::syncFromStore() {
    for (auto& [workspaceId, project] : impl_->projects) {
        const auto* snapshot = impl_->store.workspace(workspaceId);
        if (!snapshot || snapshot->latestChanges == project.lastStoreChanges) continue;
        project.lastStoreChanges = snapshot->latestChanges;
        applyChanges(workspaceId, snapshot->latestChanges);
    }
}

void WorkspaceView::advanceAnimations(float deltaSeconds) {
    if (deltaSeconds <= 0.0F) return;
    for (auto& [workspaceId, project] : impl_->projects) {
        (void)workspaceId;
        for (auto iterator = project.motions.begin(); iterator != project.motions.end();) {
            iterator->second.remainingSeconds = std::max(0.0F, iterator->second.remainingSeconds - deltaSeconds);
            if (iterator->second.remainingSeconds == 0.0F) iterator = project.motions.erase(iterator);
            else ++iterator;
        }
    }
}

std::optional<FileMotion> WorkspaceView::motion(std::string_view uri) const noexcept {
    const auto* project = impl_->activeProject();
    if (!project) return std::nullopt;
    const auto found = project->motions.find(std::string(uri));
    return found == project->motions.end() ? std::nullopt : std::optional<FileMotion>(found->second);
}

const std::string& WorkspaceView::lastError() const noexcept { return impl_->error; }
void WorkspaceView::clearError() { impl_->error.clear(); }

void WorkspaceView::drawProjectSwitcher() {
    if (ImGui::GetCurrentContext() == nullptr) return;
    const auto* project = impl_->activeProject();
    const std::string name = project ? project->descriptor.displayName : "Open a project";
    const std::string path = project ? project->descriptor.rootPath : "Choose a folder to begin";
    // One line only. This button sits in a single-row toolbar, so a second
    // "\n<path>" line overflowed the bar (leaving it with a permanent scrollbar)
    // and was clipped mid-word in narrow panels. The path stays in the tooltip.
    const auto& style = ImGui::GetStyle();
    const float labelWidth =
        std::max(0.0F, ImGui::GetContentRegionAvail().x - style.FramePadding.x * 2.0F);
    const std::string label = kit::elide(name, labelWidth) + "##project-switcher";
    const bool wasOpen = ImGui::IsPopupOpen("Projects##workspace");
    if (impl_->projectPopupRequested) {
        ImGui::OpenPopup("Projects##workspace");
        impl_->projectPopupRequested = false;
    }
    if (ImGui::Button(label.c_str(), ImVec2(-1.0F, 0.0F))) {
        ImGui::OpenPopup("Projects##workspace");
        if (!wasOpen) refreshRecent();
    }
    if (ImGui::IsItemHovered()) ImGui::SetTooltip("Switch project (Ctrl/Cmd+K, then P)\n%s", path.c_str());

    if (ImGui::BeginPopup("Projects##workspace")) {
        ImGui::TextUnformatted("Projects");
        kit::dimText("Ctrl/Cmd+K, then P");
        if (kit::primaryButton("Open Folder...", ImVec2(-1.0F, 0.0F), !impl_->openPending)) {
            requestOpenFolder();
            ImGui::CloseCurrentPopup();
        }
        kit::sectionHeader("Recent projects", {.count = static_cast<int>(impl_->recent.size())});
        if (impl_->recentPending) kit::spinner("Loading recent projects");
        for (const auto& recent : impl_->recent) {
            kit::RowStyle style;
            style.secondary = recent.rootPath.c_str();
            style.tooltip = recent.rootPath.c_str();
            const std::string id = "##recent-" + recent.rootPath;
            if (kit::row(id.c_str(), recent.displayName.c_str(), style)) {
                openProject(recent.rootPath);
                ImGui::CloseCurrentPopup();
            }
        }
        if (!impl_->recentPending && impl_->recent.empty()) kit::dimText("No recent projects");
        ImGui::EndPopup();
    }
}

void WorkspaceView::draw(const char* id, float width, float height) {
    if (ImGui::GetCurrentContext() == nullptr) return;
    syncFromStore();
    advanceAnimations(anim::dt(ImGui::GetIO().DeltaTime));
    impl_->editor.processCallbacks();
    impl_->handleShortcuts();

    ImGui::SetNextWindowSize(ImVec2(width, height), ImGuiCond_Always);
    const bool visible = ImGui::BeginChild(id, ImVec2(width, height), ImGuiChildFlags_Borders);
    if (visible) {
        // No project switcher here: the shell owns it in the global toolbar, and
        // drawing it twice duplicated the control in the Explorer panel.
        if (!impl_->error.empty()) {
            ImGui::PushStyleColor(ImGuiCol_Text, ui::palette().statusErr);
            ImGui::TextWrapped("%s", impl_->error.c_str());
            ImGui::PopStyleColor();
        }
        impl_->drawSearchPanel();
        impl_->drawTree();
        impl_->drawPendingPopup();
    }
    ImGui::EndChild();
}

} // namespace chud::workspace
