#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

namespace chud {

using Json = nlohmann::json;
using RequestId = std::uint64_t;
using WorkspaceId = std::string;
using DocumentId = std::string;
using DocumentUri = std::string;
using TerminalId = std::string;

inline constexpr int kDesktopProtocolVersion = 1;

struct ImageContent {
    std::string data;
    std::string mimeType;
    bool operator==(const ImageContent&) const = default;
};

struct DesktopSessionInfo {
    enum class Status { Completed, Failed, Interrupted, Active };
    std::string id;
    std::string path;
    std::string cwd;
    std::optional<std::string> title;
    std::optional<std::string> parentSessionPath;
    std::int64_t createdMs;
    std::int64_t modifiedMs;
    std::int64_t messageCount;
    std::int64_t size;
    std::optional<Status> status;
    std::optional<bool> pinned;
    bool operator==(const DesktopSessionInfo&) const = default;
};

struct DesktopSessionTab {
    std::string path;
    std::string title;
    std::string cwd;
    bool active;
    bool running;
    std::int64_t unread;
    bool draftDirty;
    bool operator==(const DesktopSessionTab&) const = default;
};

struct WorkspaceDescriptor {
    WorkspaceId id;
    std::string rootPath;
    std::string displayName;
    bool operator==(const WorkspaceDescriptor&) const = default;
};

struct RecentProject {
    std::string rootPath;
    std::string displayName;
    std::int64_t lastOpenedMs;
    bool operator==(const RecentProject&) const = default;
};

struct FileStamp {
    std::string sha256;
    std::int64_t size;
    std::int64_t mtimeNs;
    std::int64_t generation;
    bool operator==(const FileStamp&) const = default;
};

struct WorkspaceEntry {
    DocumentUri uri;
    std::string name;
    std::string relativePath;
    bool directory;
    bool ignored;
    std::optional<FileStamp> stamp;
    bool operator==(const WorkspaceEntry&) const = default;
};

enum class FileChangeKind { Created, Modified, Deleted, Renamed, RescanRequired };
enum class ChangeOrigin { External, Agent, User };
enum class DeleteMode { Trash, Permanent };

struct FileChange {
    FileChangeKind kind;
    DocumentUri uri;
    std::optional<DocumentUri> oldUri;
    std::optional<FileStamp> stamp;
    ChangeOrigin origin;
    bool operator==(const FileChange&) const = default;
};

struct DocumentSnapshot {
    DocumentId id;
    DocumentUri uri;
    std::string language;
    std::string text;
    FileStamp stamp;
    bool dirty;
    bool conflict;
    bool operator==(const DocumentSnapshot&) const = default;
};

enum class SearchKind { Files, Content, Symbols };
struct SearchQuery {
    std::string text;
    SearchKind kind;
    std::optional<std::int64_t> maxResults;
    std::optional<bool> includeIgnored;
    bool operator==(const SearchQuery&) const = default;
};
struct SearchResult {
    DocumentUri uri;
    std::optional<std::int64_t> line;
    std::optional<std::int64_t> column;
    std::string preview;
    std::optional<double> score;
    bool operator==(const SearchResult&) const = default;
};

struct GitFileState {
    std::string path;
    std::string staged;
    std::string unstaged;
    bool untracked;
    bool operator==(const GitFileState&) const = default;
};
struct GitCommit {
    std::string hash;
    std::vector<std::string> parents;
    std::string author;
    std::int64_t timestampMs;
    std::string subject;
    std::vector<std::string> refs;
    bool operator==(const GitCommit&) const = default;
};
struct GitBranch {
    std::string name;
    bool current;
    bool remote;
    std::optional<std::string> upstream;
    std::optional<std::int64_t> ahead;
    std::optional<std::int64_t> behind;
    bool operator==(const GitBranch&) const = default;
};
struct GitRemote {
    std::string name;
    std::string fetchUrl;
    std::string pushUrl;
    bool operator==(const GitRemote&) const = default;
};
struct GitSnapshot {
    std::string root;
    std::string branch;
    std::optional<std::string> upstream;
    std::int64_t ahead;
    std::int64_t behind;
    std::vector<GitFileState> files;
    std::vector<GitCommit> commits;
    bool operator==(const GitSnapshot&) const = default;
};

struct LspPosition {
    std::int64_t line;
    std::int64_t column;
    bool operator==(const LspPosition&) const = default;
};
struct LspRange {
    LspPosition start;
    LspPosition end;
    bool operator==(const LspRange&) const = default;
};
struct LspDiagnostic {
    DocumentUri uri;
    std::uint8_t severity;
    std::string message;
    std::optional<std::string> source;
    std::int64_t startLine;
    std::int64_t startColumn;
    std::int64_t endLine;
    std::int64_t endColumn;
    bool operator==(const LspDiagnostic&) const = default;
};

enum class GraphState { Entering, Stable, Changing, Leaving };
enum class GraphKind { Code, Git, Agent };
using JsonScalar = std::variant<std::nullptr_t, std::string, double, bool>;
struct GraphNode {
    std::string id;
    std::string label;
    std::string kind;
    std::optional<std::string> group;
    std::optional<GraphState> state;
    std::map<std::string, JsonScalar> meta;
    bool operator==(const GraphNode&) const = default;
};
struct GraphEdge {
    std::string id;
    std::string source;
    std::string target;
    std::string kind;
    std::optional<GraphState> state;
    bool operator==(const GraphEdge&) const = default;
};
struct GraphSnapshot {
    std::int64_t revision;
    std::vector<GraphNode> nodes;
    std::vector<GraphEdge> edges;
    bool operator==(const GraphSnapshot&) const = default;
};

struct SessionHeader {
    std::string id;
    std::optional<std::string> title;
    std::string timestamp;
    std::string cwd;
    bool operator==(const SessionHeader&) const = default;
};

// Current pi-wire entry tags are typed. A future tag is retained losslessly as Unknown so
// additive protocol evolution cannot discard the rest of an otherwise valid session snapshot.
enum class SessionEntryKind { Message, CustomMessage, Compaction, BranchSummary, ModelChange, ThinkingLevelChange, Unknown };
struct SessionEntry {
    SessionEntryKind kind;
    std::string id;
    std::optional<std::string> parentId;
    std::string timestamp;
    Json payload;
    bool operator==(const SessionEntry&) const = default;
};

struct WireModel {
    std::string id;
    std::string name;
    std::string provider;
    std::optional<std::int64_t> contextWindow;
    bool operator==(const WireModel&) const = default;
};
struct ContextUsage {
    std::optional<std::int64_t> tokens;
    std::optional<std::int64_t> contextWindow;
    std::optional<double> percent;
    bool operator==(const ContextUsage&) const = default;
};
struct Participant {
    enum class Role { Host, Guest };
    std::string name;
    Role role;
    std::optional<bool> readOnly;
    bool operator==(const Participant&) const = default;
};
struct SessionState {
    bool isStreaming;
    std::int64_t queuedMessageCount;
    std::optional<std::string> sessionName;
    std::string cwd;
    std::optional<WireModel> model;
    std::optional<std::string> thinkingLevel;
    std::optional<ContextUsage> contextUsage;
    std::vector<Participant> participants;
    std::optional<bool> isAborting;
    bool operator==(const SessionState&) const = default;
};
struct AgentSnapshot {
    enum class Kind { Main, Sub };
    enum class Status { Running, Idle, Parked, Aborted };
    std::string id;
    std::string displayName;
    Kind kind;
    std::optional<std::string> parentId;
    Status status;
    bool hasSessionFile;
    std::int64_t createdAt;
    std::int64_t lastActivity;
    bool operator==(const AgentSnapshot&) const = default;
};

struct AgentEvent { std::string type; Json payload; bool operator==(const AgentEvent&) const = default; };
struct UiRequest { std::int64_t reqId; std::string kind; std::string title; Json payload; bool operator==(const UiRequest&) const = default; };

struct RequestFrame { RequestId id; std::string method; Json params; bool operator==(const RequestFrame&) const = default; };
struct ResponseError { std::string code; std::string message; bool operator==(const ResponseError&) const = default; };
struct ResponseFrame {
    RequestId id;
    std::string method;
    std::optional<Json> result;
    std::optional<ResponseError> error;
    bool operator==(const ResponseFrame&) const = default;
};

struct WelcomeEvent { std::string sessionPath; int protocol; SessionHeader header; SessionState state; std::vector<AgentSnapshot> agents; std::int64_t entryCount; };
struct SnapshotChunkEvent { std::string sessionPath; std::vector<SessionEntry> entries; bool final; };
struct EntryEvent { std::string sessionPath; SessionEntry entry; };
struct AgentEventFrame { std::string sessionPath; AgentEvent event; };
struct StateEvent { std::string sessionPath; SessionState state; };
struct BusEvent { std::string sessionPath; std::string channel; Json data; };
struct AgentsEvent { std::string sessionPath; std::vector<AgentSnapshot> agents; };
struct UiRequestEvent { std::string sessionPath; UiRequest request; };
struct UiRequestEndEvent { std::string sessionPath; std::int64_t reqId; };
struct SessionsEvent { std::vector<DesktopSessionInfo> sessions; };
struct SessionTabsEvent { std::vector<DesktopSessionTab> tabs; };
struct WorkspaceChangeEvent { WorkspaceId workspaceId; std::vector<FileChange> changes; };
struct DocumentEvent { DocumentSnapshot document; ChangeOrigin origin; };
struct GitEvent { WorkspaceId workspaceId; GitSnapshot snapshot; };
struct TerminalDataEvent { TerminalId terminalId; std::string dataBase64; };
struct TerminalExitEvent { TerminalId terminalId; std::optional<std::int64_t> exitCode; std::optional<std::string> signal; };
struct DiagnosticsEvent { WorkspaceId workspaceId; std::vector<LspDiagnostic> diagnostics; };
struct GraphEvent { WorkspaceId workspaceId; GraphKind kind; GraphSnapshot graph; };
struct ErrorEvent { std::optional<std::string> sessionPath; std::string code; std::string message; };
struct UnknownEvent { std::string type; Json raw; };

using EventPayload = std::variant<WelcomeEvent, SnapshotChunkEvent, EntryEvent, AgentEventFrame,
    StateEvent, BusEvent, AgentsEvent, UiRequestEvent, UiRequestEndEvent, SessionsEvent,
    SessionTabsEvent, WorkspaceChangeEvent, DocumentEvent, GitEvent, TerminalDataEvent,
    TerminalExitEvent, DiagnosticsEvent, GraphEvent, ErrorEvent, UnknownEvent>;
struct EventFrame { EventPayload payload; };
using DesktopFrame = std::variant<RequestFrame, ResponseFrame, EventFrame>;

} // namespace chud
