#pragma once

#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

#include "copilot/copilot_view.h"
#include "protocol/desktop_store.h"

namespace chud::session_graph {

enum class NodeKind { Session, Agent, Task, Tool, Recovery };
enum class NodeState { Active, Idle, Pending, Done, Parked, Failed, Unknown };

struct SessionDagNode {
    std::string id;
    std::string parentId;
    std::string referenceId;
    std::string label;
    std::string detail;
    NodeKind kind = NodeKind::Session;
    NodeState state = NodeState::Unknown;
    std::uint64_t ordinal = 0;
    std::int64_t startedAt = 0;
    std::int64_t lastActivity = 0;
    bool orphan = false;
    bool recoverable = false;
    std::vector<std::string> resources;

    bool operator==(const SessionDagNode&) const = default;
};

struct SessionDagEdge {
    std::string source;
    std::string target;
    std::string label;

    bool operator==(const SessionDagEdge&) const = default;
};

struct SessionDag {
    std::string sessionPath;
    std::vector<SessionDagNode> nodes;
    std::vector<SessionDagEdge> edges;

    bool operator==(const SessionDag&) const = default;
};

[[nodiscard]] SessionDag buildSessionDag(
    std::string_view sessionPath,
    const SessionSnapshot* snapshot,
    const copilot::TranscriptProjection& projection);

[[nodiscard]] std::string toMermaid(const SessionDag& dag);
[[nodiscard]] std::string_view nodeKindLabel(NodeKind kind) noexcept;
[[nodiscard]] std::string_view nodeStateLabel(NodeState state) noexcept;

}  // namespace chud::session_graph
