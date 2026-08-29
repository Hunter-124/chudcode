#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <imgui.h>

#include "graph/force_graph.h"
#include "protocol/wire_types.h"

namespace chud {

struct SourceLocation {
  std::string uri;
  std::int64_t line = 0;
  std::int64_t column = 0;

  friend bool operator==(const SourceLocation&, const SourceLocation&) = default;
};

struct GraphCamera {
  GraphVec2 center{};
  float zoom = 1.0F;

  friend bool operator==(const GraphCamera&, const GraphCamera&) = default;
};

enum class GraphCameraReason { Fit, Search, Selection, Scope, Restore };

struct GraphCameraTarget {
  GraphCamera camera;
  GraphCameraReason reason = GraphCameraReason::Fit;
  std::uint64_t serial = 0;
};

struct GraphFilter {
  std::unordered_set<std::string> nodeKinds;
  std::unordered_set<std::string> groups;
  bool showEntering = true;
  bool showLeaving = true;
};

struct GraphAccessibleItem {
  std::string id;
  std::string label;
  std::string kind;
  std::string group;
  bool selected = false;
  bool pinned = false;
  bool hasSource = false;
};

enum class GraphListAction { Select, Focus, OpenSource, TogglePin };

struct GraphNodeVisualState {
  float alpha = 1.0F;
  float scale = 1.0F;
  bool leaving = false;
  bool changed = false;
};

struct GraphDrawResult {
  bool selectionChanged = false;
  bool sourceOpened = false;
  bool cameraChanged = false;
};

// A scene with no nodes is not self-explaining: it can mean no project, a
// snapshot still in flight, a snapshot that never arrived, or a project whose
// graph is genuinely empty. The canvas needs all four apart to stay honest.
enum class GraphSceneState { NoWorkspace, Pending, Unavailable, Ready };

class GraphView {
 public:
  static constexpr int kCacheSchemaVersion = 2;

  using OpenSourceCallback = std::function<void(const SourceLocation&)>;

  explicit GraphView(ForceGraphConfig config = {});
  ~GraphView();

  GraphView(const GraphView&) = delete;
  GraphView& operator=(const GraphView&) = delete;

  void setWorkspace(std::string workspaceId);
  [[nodiscard]] const std::string& workspace() const noexcept;
  void setKind(GraphKind kind);
  [[nodiscard]] GraphKind kind() const noexcept;
  [[nodiscard]] GraphSceneState sceneState(GraphKind kind) const;

  // Updates only the addressed scene. Code, git, and agent scenes share the
  // same camera and selection authority while retaining independent layouts.
  void update(GraphKind kind, const GraphSnapshot& snapshot);
  void tick(float deltaSeconds);

  [[nodiscard]] const ForceGraph& solver(GraphKind kind) const;
  [[nodiscard]] ForceGraph& solver(GraphKind kind);
  [[nodiscard]] std::optional<GraphNodeVisualState> nodeVisual(std::string_view id) const;

  void setSearch(std::string query);
  [[nodiscard]] const std::string& search() const noexcept;
  [[nodiscard]] std::vector<std::string> searchMatches() const;
  void setFilter(GraphFilter filter);
  [[nodiscard]] const GraphFilter& filter() const noexcept;
  void setScope(std::optional<std::string> rootId, int hops = 1);
  [[nodiscard]] bool visible(std::string_view nodeId) const;

  [[nodiscard]] const std::optional<std::string>& selection() const noexcept;
  bool select(std::string_view nodeId);
  void clearSelection();
  bool openSource(std::string_view nodeId);
  void setOpenSourceCallback(OpenSourceCallback callback);

  void pan(GraphVec2 screenDelta);
  void zoomAt(float factor, GraphVec2 screenPoint, ImVec2 viewportSize);
  void requestCamera(GraphCamera camera, GraphCameraReason reason, bool animated = true);
  bool fit(ImVec2 viewportSize, bool animated = true);
  bool focus(std::string_view nodeId, ImVec2 viewportSize,
             GraphCameraReason reason = GraphCameraReason::Selection, bool animated = true);
  bool focusFirstSearchResult(ImVec2 viewportSize, bool animated = true);
  [[nodiscard]] const GraphCamera& camera() const noexcept;
  [[nodiscard]] const std::optional<GraphCameraTarget>& cameraTarget() const noexcept;

  [[nodiscard]] GraphVec2 worldToScreen(GraphVec2 world, ImVec2 viewportSize) const;
  [[nodiscard]] GraphVec2 screenToWorld(GraphVec2 screen, ImVec2 viewportSize) const;
  [[nodiscard]] std::optional<std::string> hitTest(GraphVec2 screen, ImVec2 viewportSize) const;
  bool clickAt(GraphVec2 screen, ImVec2 viewportSize, bool openOnActivation = false);
  bool beginDrag(GraphVec2 screen, ImVec2 viewportSize);
  bool dragTo(GraphVec2 screen, ImVec2 viewportSize);
  bool endDrag(bool pinNode);
  bool setPinned(std::string_view nodeId, bool pinned);

  [[nodiscard]] std::vector<GraphAccessibleItem> accessibleItems() const;
  bool performListAction(std::string_view nodeId, GraphListAction action,
                         ImVec2 viewportSize = ImVec2(800.0F, 600.0F));
  void setAccessibleFallback(bool enabled);
  [[nodiscard]] bool accessibleFallback() const noexcept;

  GraphDrawResult draw(const char* id, ImVec2 size);
  GraphDrawResult drawCanvas(const char* id, ImVec2 size);
  GraphDrawResult drawAccessibleList(const char* id, ImVec2 size);

  // Cache payloads are self-identifying and rejected unless schema,
  // workspace, and graph kind all match the requested scene.
  [[nodiscard]] std::string exportCache(std::string_view workspaceId, GraphKind kind) const;
  bool importCache(std::string_view payload, std::string_view workspaceId, GraphKind kind);
  [[nodiscard]] static std::string cacheKey(std::string_view workspaceId, GraphKind kind);

  // Deterministic git targets. Group names define stable lanes; ids define
  // within-lane order, making the result independent of snapshot array order.
  [[nodiscard]] static std::map<std::string, GraphVec2, std::less<>> computeGitLaneLayout(
      const GraphSnapshot& snapshot, float columnSpacing = 132.0F,
      float laneSpacing = 84.0F);
  [[nodiscard]] std::optional<GraphVec2> gitLaneTarget(std::string_view nodeId) const;

 private:
  struct VisualNode;
  struct VisualEdge;
  struct Scene;

  [[nodiscard]] Scene& activeScene();
  [[nodiscard]] const Scene& activeScene() const;
  [[nodiscard]] Scene& scene(GraphKind kind);
  [[nodiscard]] const Scene& scene(GraphKind kind) const;
  void rebuildSolver(Scene& scene);
  void rebuildScope();
  void initializeAnimation(GraphKind kind, std::string_view id, bool edge);
  void forgetAnimation(GraphKind kind, std::string_view id, bool edge);
  [[nodiscard]] ImGuiID animationId(GraphKind kind, std::string_view id,
                                    std::string_view channel) const;
  [[nodiscard]] static std::optional<SourceLocation> sourceFrom(const GraphNode& node);

  Scene* scenes_;
  GraphKind kind_ = GraphKind::Code;
  std::string workspaceId_;
  GraphCamera camera_;
  std::optional<GraphCameraTarget> cameraTarget_;
  std::uint64_t cameraSerial_ = 0;
  std::optional<std::string> selection_;
  GraphCamera cameraStart_;
  float cameraDuration_ = 0.0F;
  std::optional<std::string> dragging_;
  GraphVec2 dragOffset_;
  std::string search_;
  bool dragWasPinned_ = false;
  GraphFilter filter_;
  std::optional<std::string> scopeRoot_;
  int scopeHops_ = 1;
  std::unordered_set<std::string, GraphStringHash, std::equal_to<>> scopedIds_;
  OpenSourceCallback openSourceCallback_;
  bool accessibleFallback_ = false;
  ImVec2 lastViewportSize_{800.0F, 600.0F};
};

}  // namespace chud
