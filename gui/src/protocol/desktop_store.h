#pragma once

#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "protocol/wire_types.h"

namespace chud {

class StoreError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct SessionSnapshot {
    std::optional<SessionHeader> header;
    std::optional<SessionState> state;
    std::vector<AgentSnapshot> agents;
    std::vector<SessionEntry> entries;
    std::int64_t expectedEntryCount = 0;
    bool snapshotComplete = false;
    std::optional<AgentEvent> latestAgentEvent;
    std::optional<UiRequest> uiRequest;
    std::vector<BusEvent> busEvents;
};

struct WorkspaceSnapshot {
    std::optional<WorkspaceDescriptor> descriptor;
    std::vector<WorkspaceEntry> entries;
    std::unordered_map<DocumentId, DocumentSnapshot> documentsById;
    std::unordered_map<DocumentUri, DocumentId> documentIdsByUri;
    std::optional<GitSnapshot> git;
    std::vector<LspDiagnostic> diagnostics;
    std::map<GraphKind, GraphSnapshot> graphs;
    std::vector<FileChange> latestChanges;
};

struct TerminalSnapshot {
    std::vector<std::uint8_t> bytes;
    bool exited = false;
    std::optional<std::int64_t> exitCode;
    std::optional<std::string> signal;
};

class DesktopStore {
public:
    void apply(const EventFrame& event);
    void applyResponse(std::string_view method, const Json& params, const Json& result);

    const std::vector<DesktopSessionInfo>& sessions() const noexcept { return sessions_; }
    const std::vector<DesktopSessionTab>& tabs() const noexcept { return tabs_; }
    const std::vector<RecentProject>& recentProjects() const noexcept { return recentProjects_; }
    const std::optional<std::string>& activeSessionPath() const noexcept { return activeSessionPath_; }

    const SessionSnapshot* session(std::string_view path) const noexcept;
    SessionSnapshot* session(std::string_view path) noexcept;
    const SessionSnapshot* activeSession() const noexcept;
    const WorkspaceSnapshot* workspace(std::string_view id) const noexcept;
    WorkspaceSnapshot* workspace(std::string_view id) noexcept;
    const DocumentSnapshot* documentById(std::string_view id) const noexcept;
    const DocumentSnapshot* documentByUri(std::string_view uri) const noexcept;
    const TerminalSnapshot* terminal(std::string_view id) const noexcept;
    const GraphSnapshot* graph(std::string_view workspaceId, GraphKind kind) const noexcept;
    const std::vector<ErrorEvent>& errors() const noexcept { return errors_; }
    std::size_t unknownEventCount() const noexcept { return unknownEventCount_; }

private:
    void markSessionActivity(const std::string& path);
    void putDocument(DocumentSnapshot document);

    std::vector<DesktopSessionInfo> sessions_;
    std::vector<DesktopSessionTab> tabs_;
    std::vector<RecentProject> recentProjects_;
    std::optional<std::string> activeSessionPath_;
    std::unordered_map<std::string, SessionSnapshot> sessionSnapshots_;
    std::unordered_map<WorkspaceId, WorkspaceSnapshot> workspaces_;
    std::unordered_map<DocumentId, DocumentSnapshot> documentsById_;
    std::unordered_map<DocumentUri, DocumentId> documentIdsByUri_;
    std::unordered_map<TerminalId, TerminalSnapshot> terminals_;
    std::vector<ErrorEvent> errors_;
    std::size_t unknownEventCount_ = 0;
};

} // namespace chud
