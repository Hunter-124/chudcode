#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace chud {

struct GraphVec2 {
  float x = 0.0F;
  float y = 0.0F;

  friend constexpr bool operator==(GraphVec2, GraphVec2) = default;
};

struct GraphStringHash {
  using is_transparent = void;

  [[nodiscard]] std::size_t operator()(std::string_view value) const noexcept;
};

struct ForceNodeInput {
  std::string id;
  float radius = 18.0F;
  bool pinned = false;
  std::optional<GraphVec2> initialPosition;
};

struct ForceEdgeInput {
  std::string id;
  std::string source;
  std::string target;
  float restLength = 96.0F;
  float strength = 1.0F;
};

struct ForceNodeState {
  std::string id;
  GraphVec2 position;
  GraphVec2 velocity;
  float radius = 18.0F;
  bool pinned = false;
};

struct ForceEdgeState {
  std::string id;
  std::string source;
  std::string target;
  std::size_t sourceIndex = 0;
  std::size_t targetIndex = 0;
  float restLength = 96.0F;
  float strength = 1.0F;
};

struct ForceGraphConfig {
  std::uint64_t deterministicSeed = 0x4348554447524150ULL;
  GraphVec2 worldMin{-8192.0F, -8192.0F};
  GraphVec2 worldMax{8192.0F, 8192.0F};
  float initialPlacementRadius = 320.0F;
  float minNodeRadius = 2.0F;
  float maxNodeRadius = 96.0F;
  float minSpringLength = 8.0F;
  float maxSpringLength = 1024.0F;
  float repulsionStrength = 4400.0F;
  float repulsionRadius = 320.0F;
  float springStrength = 7.5F;
  float centeringStrength = 0.38F;
  float collisionPadding = 3.0F;
  float collisionStrength = 34.0F;
  int collisionIterations = 3;
  float spatialCellSize = 96.0F;
  float dampingPerSixtieth = 0.82F;
  float maxSpeed = 900.0F;
  float maxStepSeconds = 0.05F;
  float coolingRate = 1.15F;
  float minimumTemperature = 0.025F;
};

struct ForceGraphStats {
  std::size_t nodeCount = 0;
  std::size_t edgeCount = 0;
  std::size_t spatialCells = 0;
  std::size_t pairChecks = 0;
  std::size_t repulsionPairs = 0;
  std::size_t collisionPairs = 0;
  std::size_t springsApplied = 0;
};

// A deterministic bounded 2D solver. Each step is O(n + m + p), where p is
// the number of candidate pairs emitted by the spatial hash (O(n^2) only for
// a pathologically dense cell). Memory is O(n + m + c), c = occupied cells.
class ForceGraph {
 public:
  explicit ForceGraph(ForceGraphConfig config = {});

  // Keyed replacement: states for surviving node ids are retained exactly.
  // Duplicate ids, blank ids, self edges, and edges with missing endpoints are
  // ignored deterministically.
  void update(const std::vector<ForceNodeInput>& nodes,
              const std::vector<ForceEdgeInput>& edges);
  void clear();
  void step(float deltaSeconds);
  void reheat(float temperature = 1.0F);

  [[nodiscard]] const ForceGraphConfig& config() const noexcept;
  [[nodiscard]] const std::vector<ForceNodeState>& nodes() const noexcept;
  [[nodiscard]] const std::vector<ForceEdgeState>& edges() const noexcept;
  [[nodiscard]] const ForceGraphStats& stats() const noexcept;
  [[nodiscard]] const ForceNodeState* findNode(std::string_view id) const noexcept;
  [[nodiscard]] ForceNodeState* findNode(std::string_view id) noexcept;
  [[nodiscard]] float temperature() const noexcept;
  [[nodiscard]] bool cooled() const noexcept;

  bool setNodePosition(std::string_view id, GraphVec2 position, bool clearVelocity = true);
  bool setPinned(std::string_view id, bool pinned);

 private:
  void rebuildIndex();
  [[nodiscard]] GraphVec2 seededPosition(std::string_view id) const;
  [[nodiscard]] GraphVec2 boundedPosition(GraphVec2 position, float radius) const;

  ForceGraphConfig config_;
  std::vector<ForceNodeState> nodes_;
  std::vector<ForceEdgeState> edges_;
  std::unordered_map<std::string, std::size_t, GraphStringHash, std::equal_to<>> nodeIndex_;
  ForceGraphStats stats_;
  float temperature_ = 1.0F;
};

}  // namespace chud
