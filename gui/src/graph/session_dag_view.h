#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>

#include <imgui.h>

#include "graph/session_dag.h"

namespace chud::session_graph {

class SessionDagView {
public:
    using OpenAgentCallback = std::function<void(std::string_view)>;

    void sync(std::string_view sessionPath,
              const SessionSnapshot* snapshot,
              const copilot::TranscriptProjection& projection);
    bool draw(const char* id, ImVec2 size,
              OpenAgentCallback openAgent = {});

    [[nodiscard]] const SessionDag& dag() const noexcept { return dag_; }
    [[nodiscard]] const std::string& mermaid() const noexcept { return mermaid_; }
    [[nodiscard]] const std::optional<std::string>& selection() const noexcept {
        return selection_;
    }
    bool select(std::string_view nodeId);
    void fit();
    [[nodiscard]] std::optional<ImVec2> layoutPosition(
        std::string_view nodeId) const noexcept;

private:
    struct LayoutNode {
        float x = 0.0F;
        float y = 0.0F;
        std::uint64_t column = 0;
        int lane = 0;
    };

    [[nodiscard]] std::uint64_t stampFor(
        std::string_view sessionPath,
        const SessionSnapshot* snapshot,
        const copilot::TranscriptProjection& projection) const;
    void rebuildLayout();
    [[nodiscard]] const SessionDagNode* node(std::string_view id) const noexcept;

    SessionDag dag_;
    std::string mermaid_;
    std::unordered_map<std::string, LayoutNode> layout_;
    std::unordered_map<std::string, std::uint64_t> columns_;
    std::unordered_map<std::string, int> lanes_;
    std::optional<std::string> selection_;
    std::uint64_t stamp_ = 0;
    std::uint64_t nextColumn_ = 0;
    int nextLane_ = 1;
    ImVec2 pan_{40.0F, 58.0F};
    float zoom_ = 1.0F;
    bool fitRequested_ = true;
};

}  // namespace chud::session_graph
