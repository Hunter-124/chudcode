#include "graph/session_dag_view.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <unordered_set>

#include "theme/theme.h"
#include "widgets/kit.h"

namespace chud::session_graph {
namespace {

constexpr float kNodeWidth = 196.0F;
constexpr float kNodeHeight = 66.0F;
constexpr float kColumnSpacing = 232.0F;
constexpr float kLaneSpacing = 104.0F;

void mix(std::uint64_t& seed, std::uint64_t value) {
    seed ^= value + 0x9e3779b97f4a7c15ULL + (seed << 6U) + (seed >> 2U);
}

void mix(std::uint64_t& seed, std::string_view value) {
    mix(seed, static_cast<std::uint64_t>(std::hash<std::string_view>{}(value)));
}

ImVec4 stateColor(NodeState state) {
    const auto& palette = ui::palette();
    switch (state) {
        case NodeState::Active: return palette.graphAccent;
        case NodeState::Done: return palette.graphOk;
        case NodeState::Failed: return palette.graphErr;
        case NodeState::Parked: return palette.graphWarn;
        case NodeState::Pending: return palette.graphInfo;
        case NodeState::Idle: return palette.graphNeutral;
        case NodeState::Unknown: return palette.textDisabled;
    }
    return palette.textDisabled;
}

ImVec4 kindColor(NodeKind kind) {
    const auto& palette = ui::palette();
    switch (kind) {
        case NodeKind::Session: return palette.graphAccent;
        case NodeKind::Agent: return palette.graphInfo;
        case NodeKind::Task: return palette.graphNeutral;
        case NodeKind::Tool: return palette.graphOk;
        case NodeKind::Recovery: return palette.graphWarn;
    }
    return palette.graphNeutral;
}

bool inside(ImVec2 point, ImVec2 minimum, ImVec2 maximum) {
    return point.x >= minimum.x && point.x <= maximum.x &&
           point.y >= minimum.y && point.y <= maximum.y;
}

std::string durationLabel(const SessionDagNode& node) {
    if (node.startedAt <= 0 || node.lastActivity <= node.startedAt) return {};
    std::int64_t elapsed = node.lastActivity - node.startedAt;
    if (elapsed > 10'000) elapsed /= 1000;
    if (elapsed < 60) return std::to_string(elapsed) + "s";
    if (elapsed < 3600) return std::to_string(elapsed / 60) + "m";
    return std::to_string(elapsed / 3600) + "h";
}

}  // namespace

std::uint64_t SessionDagView::stampFor(
    std::string_view sessionPath,
    const SessionSnapshot* snapshot,
    const copilot::TranscriptProjection& projection) const {
    std::uint64_t stamp = 0x53455353494f4e44ULL;
    mix(stamp, sessionPath);
    mix(stamp, snapshot == nullptr ? 0U : 1U);
    if (snapshot != nullptr) {
        if (snapshot->header) {
            mix(stamp, snapshot->header->id);
            mix(stamp, snapshot->header->title.value_or(std::string{}));
            mix(stamp, snapshot->header->cwd);
        }
        if (snapshot->state) {
            mix(stamp, snapshot->state->sessionName.value_or(std::string{}));
            mix(stamp, snapshot->state->cwd);
            mix(stamp, snapshot->state->isStreaming ? 1U : 0U);
            mix(stamp, static_cast<std::uint64_t>(snapshot->state->queuedMessageCount));
        }
        for (const auto& agent : snapshot->agents) {
            mix(stamp, agent.id);
            mix(stamp, agent.displayName);
            mix(stamp, agent.parentId.value_or(std::string{}));
            mix(stamp, static_cast<std::uint64_t>(agent.kind));
            mix(stamp, static_cast<std::uint64_t>(agent.status));
            mix(stamp, static_cast<std::uint64_t>(agent.createdAt));
            mix(stamp, static_cast<std::uint64_t>(agent.lastActivity));
        }
    }
    for (const auto& task : projection.tasks) {
        mix(stamp, task.id);
        mix(stamp, task.parentId.value_or(std::string{}));
        mix(stamp, task.state);
        mix(stamp, task.phase);
        mix(stamp, task.title);
    }
    for (const auto& row : projection.rows) {
        if (row.kind != copilot::TranscriptKind::Tool &&
            row.kind != copilot::TranscriptKind::Status &&
            row.kind != copilot::TranscriptKind::System &&
            row.kind != copilot::TranscriptKind::ToolResult)
            continue;
        mix(stamp, row.id);
        mix(stamp, row.title);
        mix(stamp, row.text);
        mix(stamp, row.meta);
        mix(stamp, static_cast<std::uint64_t>(row.kind));
        mix(stamp, row.live ? 1U : 0U);
        mix(stamp, row.failed ? 1U : 0U);
        mix(stamp, static_cast<std::uint64_t>(std::hash<Json>{}(row.detail)));
    }
    for (const auto& tool : projection.activeTools) {
        mix(stamp, tool.id);
        mix(stamp, tool.name);
        mix(stamp, tool.intent);
        mix(stamp, static_cast<std::uint64_t>(std::hash<Json>{}(tool.arguments)));
    }
    return stamp;
}

void SessionDagView::sync(std::string_view sessionPath,
                          const SessionSnapshot* snapshot,
                          const copilot::TranscriptProjection& projection) {
    const std::uint64_t nextStamp = stampFor(sessionPath, snapshot, projection);
    if (nextStamp == stamp_) return;
    const bool sessionChanged = dag_.sessionPath != sessionPath;
    stamp_ = nextStamp;
    dag_ = buildSessionDag(sessionPath, snapshot, projection);
    mermaid_ = toMermaid(dag_);
    if (sessionChanged) {
        layout_.clear();
        columns_.clear();
        lanes_.clear();
        selection_.reset();
        nextColumn_ = 0;
        nextLane_ = 1;
        fitRequested_ = true;
    }
    rebuildLayout();
    if (selection_ && node(*selection_) == nullptr) selection_.reset();
}

void SessionDagView::rebuildLayout() {
    std::unordered_set<std::string> live;
    live.reserve(dag_.nodes.size());
    for (const auto& node : dag_.nodes) live.insert(node.id);
    const auto prune = [&](auto& values) {
        for (auto iterator = values.begin(); iterator != values.end();) {
            if (!live.contains(iterator->first))
                iterator = values.erase(iterator);
            else
                ++iterator;
        }
    };
    prune(layout_);
    prune(columns_);
    prune(lanes_);

    for (const auto& node : dag_.nodes) {
        std::uint64_t parentColumn = 0;
        int parentLane = 0;
        if (!node.parentId.empty()) {
            if (const auto parent = columns_.find(node.parentId); parent != columns_.end())
                parentColumn = parent->second;
            if (const auto parent = lanes_.find(node.parentId); parent != lanes_.end())
                parentLane = parent->second;
        }

        auto column = columns_.find(node.id);
        if (column == columns_.end()) {
            const std::uint64_t assigned = node.kind == NodeKind::Session
                                               ? 0
                                               : std::max(nextColumn_, parentColumn + 1U);
            column = columns_.emplace(node.id, assigned).first;
            nextColumn_ = std::max(nextColumn_, assigned + 1U);
        }

        auto lane = lanes_.find(node.id);
        if (lane == lanes_.end()) {
            int assigned = 0;
            if (node.kind == NodeKind::Session) {
                assigned = 0;
            } else if (node.kind == NodeKind::Agent) {
                assigned = node.parentId == "session:root" && !node.orphan &&
                                   lanes_.size() <= 1
                               ? 0
                               : nextLane_++;
            } else if (node.kind == NodeKind::Tool) {
                assigned = parentLane;
            } else if (node.kind == NodeKind::Task &&
                       node.parentId.starts_with("task:")) {
                assigned = parentLane;
            } else {
                assigned = nextLane_++;
            }
            lane = lanes_.emplace(node.id, assigned).first;
        }
        layout_[node.id] = LayoutNode{static_cast<float>(column->second) * kColumnSpacing,
                                      static_cast<float>(lane->second) * kLaneSpacing,
                                      column->second, lane->second};
    }
}

const SessionDagNode* SessionDagView::node(std::string_view id) const noexcept {
    const auto found = std::find_if(dag_.nodes.begin(), dag_.nodes.end(),
                                    [&](const SessionDagNode& candidate) {
                                        return candidate.id == id;
                                    });
    return found == dag_.nodes.end() ? nullptr : &*found;
}

bool SessionDagView::select(std::string_view nodeId) {
    if (node(nodeId) == nullptr) return false;
    const bool changed = !selection_ || *selection_ != nodeId;
    selection_ = std::string(nodeId);
    return changed;
}

void SessionDagView::fit() { fitRequested_ = true; }

std::optional<ImVec2> SessionDagView::layoutPosition(
    std::string_view nodeId) const noexcept {
    const auto found = layout_.find(std::string(nodeId));
    if (found == layout_.end()) return std::nullopt;
    return ImVec2{found->second.x, found->second.y};
}

bool SessionDagView::draw(const char* id, ImVec2 size,
                          OpenAgentCallback openAgent) {
    bool selectionChanged = false;
    ImGui::PushID(id);
    if (ImGui::Button("Copy Mermaid")) ImGui::SetClipboardText(mermaid_.c_str());
    ImGui::SameLine();
    if (ImGui::Button("Fit")) fitRequested_ = true;
    ImGui::SameLine();
    ImGui::TextColored(ui::palette().textDim, "%zu nodes · %zu edges",
                       dag_.nodes.size(), dag_.edges.size());
    if (selection_) {
        if (const auto* selected = node(*selection_)) {
            ImGui::SameLine();
            ImGui::TextColored(stateColor(selected->state), "%s · %s",
                               selected->label.c_str(),
                               nodeStateLabel(selected->state).data());
        }
    }

    const float toolbar = ImGui::GetFrameHeightWithSpacing();
    const ImVec2 canvasSize{
        size.x > 0.0F ? size.x : ImGui::GetContentRegionAvail().x,
        size.y > 0.0F
            ? std::max(1.0F, size.y - toolbar)
            : std::max(1.0F, ImGui::GetContentRegionAvail().y)};
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().windowBg);
    ImGui::BeginChild("##session-dag-canvas", canvasSize, ImGuiChildFlags_Borders,
                      ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
    ImGui::PopStyleColor();
    const ImVec2 canvasMin = ImGui::GetCursorScreenPos();
    const ImVec2 available = ImGui::GetContentRegionAvail();
    ImGui::InvisibleButton("##canvas", available,
                           ImGuiButtonFlags_MouseButtonLeft |
                               ImGuiButtonFlags_MouseButtonRight |
                               ImGuiButtonFlags_MouseButtonMiddle);
    const bool hovered = ImGui::IsItemHovered();
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    const ImVec2 canvasMax{canvasMin.x + available.x, canvasMin.y + available.y};
    drawList->AddRectFilled(canvasMin, canvasMax, ui::toU32(ui::palette().windowBg));
    const float sceneScale = ui::metrics::scale();

    if (fitRequested_ && !layout_.empty()) {
        float maximumX = 0.0F;
        float maximumY = 0.0F;
        for (const auto& [_, layout] : layout_) {
            maximumX = std::max(maximumX, layout.x + kNodeWidth);
            maximumY = std::max(maximumY, layout.y + kNodeHeight);
        }
        const float fitX =
            (available.x - ui::metrics::px(80.0F)) /
            std::max(maximumX * sceneScale, 1.0F);
        const float fitY =
            (available.y - ui::metrics::px(80.0F)) /
            std::max(maximumY * sceneScale, 1.0F);
        zoom_ = std::clamp(std::min(fitX, fitY), 0.28F, 1.25F);
        pan_ = {ui::metrics::px(40.0F), ui::metrics::px(40.0F)};
        fitRequested_ = false;
    }

    ImGuiIO& io = ImGui::GetIO();
    if (hovered && io.MouseWheel != 0.0F) {
        const float previous = zoom_;
        const ImVec2 local{io.MousePos.x - canvasMin.x - pan_.x,
                           io.MousePos.y - canvasMin.y - pan_.y};
        zoom_ = std::clamp(zoom_ * std::pow(1.12F, io.MouseWheel), 0.22F, 2.4F);
        if (previous > 0.0F) {
            pan_.x -= local.x * (zoom_ / previous - 1.0F);
            pan_.y -= local.y * (zoom_ / previous - 1.0F);
        }
    }
    if (hovered && (ImGui::IsMouseDragging(ImGuiMouseButton_Right) ||
                    ImGui::IsMouseDragging(ImGuiMouseButton_Middle))) {
        pan_.x += io.MouseDelta.x;
        pan_.y += io.MouseDelta.y;
        ImGui::SetMouseCursor(ImGuiMouseCursor_ResizeAll);
    }

    const float scaledZoom = zoom_ * sceneScale;
    const float grid = 32.0F * scaledZoom;
    if (grid >= ui::metrics::px(10.0F)) {
        const float firstX = std::fmod(pan_.x, grid);
        const float firstY = std::fmod(pan_.y, grid);
        const ImU32 gridColor = ui::toU32(ui::withAlpha(ui::palette().border, 0.28F));
        for (float x = canvasMin.x + firstX; x < canvasMax.x; x += grid)
            drawList->AddLine({x, canvasMin.y}, {x, canvasMax.y}, gridColor);
        for (float y = canvasMin.y + firstY; y < canvasMax.y; y += grid)
            drawList->AddLine({canvasMin.x, y}, {canvasMax.x, y}, gridColor);
    }

    const auto screen = [&](float x, float y) {
        return ImVec2{canvasMin.x + pan_.x + x * scaledZoom,
                      canvasMin.y + pan_.y + y * scaledZoom};
    };

    for (const auto& edge : dag_.edges) {
        const auto sourceLayout = layout_.find(edge.source);
        const auto targetLayout = layout_.find(edge.target);
        const auto* targetNode = node(edge.target);
        if (sourceLayout == layout_.end() || targetLayout == layout_.end() ||
            targetNode == nullptr)
            continue;
        const ImVec2 source = screen(sourceLayout->second.x + kNodeWidth,
                                     sourceLayout->second.y + kNodeHeight * 0.5F);
        const ImVec2 target = screen(targetLayout->second.x,
                                     targetLayout->second.y + kNodeHeight * 0.5F);
        const float bend = std::max(ui::metrics::px(28.0F),
                                    (target.x - source.x) * 0.45F);
        const ImU32 color = ui::toU32(ui::withAlpha(stateColor(targetNode->state), 0.68F));
        drawList->AddBezierCubic(source, {source.x + bend, source.y},
                                 {target.x - bend, target.y}, target, color,
                                 ui::metrics::stroke(1.5F));
        const float arrow = 5.0F * scaledZoom;
        drawList->AddTriangleFilled(target, {target.x - arrow, target.y - arrow},
                                    {target.x - arrow, target.y + arrow}, color);
    }

    std::optional<std::string> hoveredNode;
    for (const auto& dagNode : dag_.nodes) {
        const auto visual = layout_.find(dagNode.id);
        if (visual == layout_.end()) continue;
        const ImVec2 minimum = screen(visual->second.x, visual->second.y);
        const ImVec2 maximum = screen(visual->second.x + kNodeWidth,
                                      visual->second.y + kNodeHeight);
        if (maximum.x < canvasMin.x || minimum.x > canvasMax.x ||
            maximum.y < canvasMin.y || minimum.y > canvasMax.y)
            continue;
        const bool selected = selection_ && *selection_ == dagNode.id;
        const bool nodeHovered = hovered && inside(io.MousePos, minimum, maximum);
        if (nodeHovered) hoveredNode = dagNode.id;
        const ImVec4 background = nodeHovered ? ui::palette().buttonHovered
                                              : ui::palette().panelBg;
        const float rounding = ui::metrics::px(8.0F) * zoom_;
        drawList->AddRectFilled(minimum, maximum, ui::toU32(background), rounding);
        drawList->AddRectFilled(minimum,
                                {minimum.x + std::max(ui::metrics::px(3.0F),
                                                      5.0F * scaledZoom),
                                 maximum.y},
                                ui::toU32(kindColor(dagNode.kind)), rounding,
                                ImDrawFlags_RoundCornersLeft);
        drawList->AddRect(minimum, maximum,
                          ui::toU32(selected ? ui::palette().focusRing
                                             : ui::palette().borderStrong),
                          rounding, 0,
                          ui::metrics::stroke(selected ? 2.0F : 1.0F));
        const float titleSize =
            std::clamp(ui::metrics::px(13.0F) * zoom_,
                       ui::metrics::px(9.0F), ui::metrics::px(18.0F));
        const float metaSize =
            std::clamp(ui::metrics::px(10.0F) * zoom_,
                       ui::metrics::px(8.0F), ui::metrics::px(14.0F));
        const float inset = ui::metrics::px(12.0F) * zoom_;
        const std::string title = kit::elide(
            dagNode.label,
            std::max(ui::metrics::px(20.0F),
                     maximum.x - minimum.x - inset * 2.0F));
        ImFont* titleFont =
            ui::fonts().medium != nullptr ? ui::fonts().medium : ImGui::GetFont();
        drawList->AddText(titleFont, titleSize,
                          {minimum.x + inset,
                           minimum.y + ui::metrics::px(10.0F) * zoom_},
                          ui::toU32(ui::palette().text), title.c_str());
        std::string meta = std::string(nodeKindLabel(dagNode.kind)) + " · " +
                           std::string(nodeStateLabel(dagNode.state));
        if (const std::string duration = durationLabel(dagNode); !duration.empty())
            meta += " · " + duration;
        if (dagNode.orphan) meta += " · orphan";
        if (!dagNode.resources.empty())
            meta += " · " + std::to_string(dagNode.resources.size()) + " refs";
        ImFont* metaFont =
            ui::fonts().mono != nullptr ? ui::fonts().mono : ImGui::GetFont();
        drawList->AddText(metaFont, metaSize,
                          {minimum.x + inset,
                           minimum.y + ui::metrics::px(37.0F) * zoom_},
                          ui::toU32(stateColor(dagNode.state)), meta.c_str());
    }

    if (hoveredNode && ImGui::IsMouseClicked(ImGuiMouseButton_Left))
        selectionChanged = select(*hoveredNode);
    if (hoveredNode && ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left)) {
        const auto* activated = node(*hoveredNode);
        if (activated != nullptr && activated->kind == NodeKind::Agent && openAgent)
            openAgent(activated->referenceId);
    }
    if (hoveredNode) {
        const auto* value = node(*hoveredNode);
        if (value != nullptr) {
            ImGui::BeginTooltip();
            ImGui::TextUnformatted(value->label.c_str());
            ImGui::TextColored(stateColor(value->state), "%s · %s",
                               nodeKindLabel(value->kind).data(),
                               nodeStateLabel(value->state).data());
            if (!value->detail.empty()) ImGui::TextWrapped("%s", value->detail.c_str());
            if (value->orphan) ImGui::TextColored(ui::palette().statusWarn,
                                                  "Parent event is unavailable");
            if (value->recoverable) ImGui::TextColored(ui::palette().statusInfo,
                                                       "Recovery action/state available");
            if (!value->resources.empty()) {
                ImGui::Separator();
                ImGui::TextUnformatted("Files and artifacts");
                const std::size_t visible =
                    std::min<std::size_t>(value->resources.size(), 6U);
                for (std::size_t index = 0; index < visible; ++index)
                    ImGui::TextWrapped("- %s", value->resources[index].c_str());
                if (visible < value->resources.size())
                    ImGui::TextDisabled("+ %zu more",
                                        value->resources.size() - visible);
            }
            ImGui::EndTooltip();
        }
    }

    ImGui::EndChild();
    ImGui::PopID();
    return selectionChanged;
}

}  // namespace chud::session_graph
