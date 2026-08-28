#pragma once

#include <cstddef>

#include <imgui.h>

namespace chud::anim {

inline constexpr float kInstant = 0.08f;
inline constexpr float kFast = 0.14f;
inline constexpr float kBase = 0.22f;
inline constexpr float kSlow = 0.38f;
inline constexpr float kStagger = 0.02f;
inline constexpr float kBreathe = 2.40f;
inline constexpr float kMarch = 1.10f;
inline constexpr float kMaxDeltaTime = 0.05f;

[[nodiscard]] float easeOut(float t);
[[nodiscard]] float easeInOut(float t);
[[nodiscard]] float easeOutBack(float t);
[[nodiscard]] float easeSpring(float t);

// dt(raw) is also public so deterministic callers can use the same stall clamp
// without depending on an ImGui clock.
[[nodiscard]] float dt(float rawSeconds);
[[nodiscard]] float dt();

void setMotionScale(float scale);
[[nodiscard]] float motionScale();

void requestFrames();
[[nodiscard]] bool consumeFrameRequest();
void requestFrames(float seconds);

// Per-id state starts at zero, settles exponentially, and can be retargeted on
// any frame without restarting an elapsed-time animation.
[[nodiscard]] float toward(ImGuiID id, float target, float seconds);
[[nodiscard]] float peek(ImGuiID id, float fallback = 0.0f);
void forget(ImGuiID id);
void forgetAll();

// Ambient functions request another frame only when motion is enabled. Call
// them only while their visual is actually on screen.
[[nodiscard]] float pulse(float period = kBreathe);
[[nodiscard]] float phase(float period = kMarch);
[[nodiscard]] float stagger(double startedAt, std::size_t index,
                            float duration = kFast);

}  // namespace chud::anim
