#include "app/app.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#include <map>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include <GLFW/glfw3.h>
#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>

#include "copilot/copilot_view.h"
#include "editor/editor.h"
#include "graph/graph_view.h"
#include "net/ws_transport.h"
#include "protocol/desktop_client.h"
#include "protocol/desktop_store.h"
#include "terminal/terminal_model.h"
#include "terminal/terminal_view.h"
#include "theme/anim.h"
#include "theme/theme.h"
#include "vcs/vcs_view.h"
#include "widgets/kit.h"
#include "workspace/workspace_view.h"

namespace chud::app {
namespace {

namespace fs = std::filesystem;

constexpr std::string_view kProduct = "Chudcode";
constexpr std::string_view kVersion = "0.2.0";
constexpr int kMinimumWidth = 800;
constexpr int kMinimumHeight = 560;
constexpr std::uint64_t kDefaultScreenshotFrames = 300;

std::string environment(const char* name) {
    const char* value = std::getenv(name);
    return value == nullptr ? std::string{} : std::string(value);
}

bool environmentEnabled(const char* name) {
    const auto value = environment(name);
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

std::string_view optionValue(int& index, int argc, const char* const* argv,
                             std::string_view option) {
    const std::string_view argument(argv[index]);
    const std::string prefix = std::string(option) + "=";
    if (argument.starts_with(prefix)) {
        const auto value = argument.substr(prefix.size());
        if (value.empty()) throw UsageError("missing value for " + std::string(option));
        return value;
    }
    if (argument == option) {
        if (index + 1 >= argc) throw UsageError("missing value for " + std::string(option));
        const std::string_view value(argv[++index]);
        if (value.empty()) throw UsageError("missing value for " + std::string(option));
        return value;
    }
    return {};
}

std::uint64_t parsePositive(std::string_view text, std::string_view option,
                            std::uint64_t maximum) {
    std::uint64_t value = 0;
    for (const char character : text) {
        if (character < '0' || character > '9') {
            throw UsageError(std::string(option) + " requires a positive integer");
        }
        const auto digit = static_cast<std::uint64_t>(character - '0');
        if (value > (maximum - digit) / 10U) {
            throw UsageError(std::string(option) + " is out of range");
        }
        value = value * 10U + digit;
    }
    if (value == 0) throw UsageError(std::string(option) + " must be greater than zero");
    return value;
}

std::string safeOptionName(std::string_view argument) {
    const auto separator = argument.find('=');
    return std::string(argument.substr(0, separator));
}

fs::path dataDirectory() {
    auto root = environment("XDG_DATA_HOME");
    fs::path directory;
    if (!root.empty()) {
        directory = fs::path(root);
    } else {
        const auto home = environment("HOME");
        directory = home.empty() ? fs::temp_directory_path() : fs::path(home) / ".local" / "share";
    }
    directory /= "Chudcode";
    directory /= "chudcode-gui";
    directory /= std::string(kVersion);
    fs::create_directories(directory);
    return directory;
}

fs::path findAssets() {
    std::vector<fs::path> roots;
    std::error_code error;
    roots.push_back(fs::current_path(error));
#ifdef __linux__
    const auto executable = fs::read_symlink("/proc/self/exe", error);
    if (!error) roots.push_back(executable.parent_path());
#endif
    for (const auto& root : roots) {
        auto cursor = root;
        for (int level = 0; level < 6 && !cursor.empty(); ++level) {
            const auto candidate = cursor / "assets";
            if (fs::is_regular_file(candidate / "logo_icon.png", error) ||
                fs::is_regular_file(candidate / "make_logo.py", error)) {
                return candidate;
            }
            const auto parent = cursor.parent_path();
            if (parent == cursor) break;
            cursor = parent;
        }
    }
    return {};
}

struct IconPixel {
    unsigned char red = 0;
    unsigned char green = 0;
    unsigned char blue = 0;
    unsigned char alpha = 0;
};

bool insidePolygon(float x, float y, std::span<const ImVec2> polygon) {
    bool inside = false;
    for (std::size_t i = 0, previous = polygon.size() - 1; i < polygon.size(); previous = i++) {
        const auto& a = polygon[i];
        const auto& b = polygon[previous];
        if (((a.y > y) != (b.y > y)) &&
            x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) {
            inside = !inside;
        }
    }
    return inside;
}

void fillPolygon(std::vector<IconPixel>& pixels, int size, std::span<const ImVec2> polygon,
                 IconPixel color) {
    for (int y = 0; y < size; ++y) {
        for (int x = 0; x < size; ++x) {
            if (insidePolygon(static_cast<float>(x) + 0.5F, static_cast<float>(y) + 0.5F,
                              polygon)) {
                pixels[static_cast<std::size_t>(y * size + x)] = color;
            }
        }
    }
}

void setProductIcon(GLFWwindow* window, const fs::path& assets) {
    std::error_code error;
    if (assets.empty() ||
        (!fs::is_regular_file(assets / "logo_icon.png", error) &&
         !fs::is_regular_file(assets / "make_logo.py", error))) {
        return;
    }

    // This is the canonical generator's native 32 px tier. Keeping the tiny rasterizer here
    // avoids adding a second image library merely to hand GLFW an RGBA window icon.
    constexpr int size = 32;
    std::vector<IconPixel> pixels(static_cast<std::size_t>(size * size));
    for (int y = 0; y < size; ++y) {
        const float mix = static_cast<float>(y) / static_cast<float>(size - 1);
        const auto channel = [mix](int top, int bottom) {
            return static_cast<unsigned char>(std::lround(top + (bottom - top) * mix));
        };
        for (int x = 0; x < size; ++x) {
            const float dx = std::max(7.5F - static_cast<float>(x),
                                      static_cast<float>(x) - (size - 1 - 7.5F));
            const float dy = std::max(7.5F - static_cast<float>(y),
                                      static_cast<float>(y) - (size - 1 - 7.5F));
            const bool outsideCorner = dx > 0.0F && dy > 0.0F && dx * dx + dy * dy > 56.25F;
            pixels[static_cast<std::size_t>(y * size + x)] =
                IconPixel{channel(0x1E, 0x0E), channel(0x22, 0x10), channel(0x2C, 0x16),
                          static_cast<unsigned char>(outsideCorner ? 0 : 255)};
        }
    }

    const float center = 16.0F;
    const float radius = 12.32F;
    const auto point = [=](float x, float y) { return ImVec2(center + x * radius, center + y * radius); };
    const std::array<ImVec2, 6> left = {point(-0.78F, 0.0F), point(-0.46F, -0.58F),
                                        point(-0.20F, -0.58F), point(-0.50F, 0.0F),
                                        point(-0.20F, 0.58F), point(-0.46F, 0.58F)};
    std::array<ImVec2, 6> right{};
    for (std::size_t i = 0; i < left.size(); ++i) right[i] = ImVec2(size - left[i].x, left[i].y);
    fillPolygon(pixels, size, left, IconPixel{0x22, 0xBE, 0xAA, 255});
    fillPolygon(pixels, size, right, IconPixel{0x10, 0x80, 0x73, 255});
    const std::array<ImVec2, 4> leftHighlight = {left[0], left[1], left[2], left[3]};
    const std::array<ImVec2, 4> rightHighlight = {right[0], right[1], right[2], right[3]};
    fillPolygon(pixels, size, leftHighlight, IconPixel{0x42, 0xEC, 0xCE, 255});
    fillPolygon(pixels, size, rightHighlight, IconPixel{0x30, 0xD8, 0xBE, 255});

    GLFWimage image{size, size, reinterpret_cast<unsigned char*>(pixels.data())};
    glfwSetWindowIcon(window, 1, &image);
}


void appendBigEndian(std::vector<std::uint8_t>& output, std::uint32_t value) {
    output.push_back(static_cast<std::uint8_t>((value >> 24U) & 0xFFU));
    output.push_back(static_cast<std::uint8_t>((value >> 16U) & 0xFFU));
    output.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xFFU));
    output.push_back(static_cast<std::uint8_t>(value & 0xFFU));
}

std::uint32_t crc32(std::span<const std::uint8_t> bytes) {
    std::uint32_t crc = 0xFFFFFFFFU;
    for (const auto byte : bytes) {
        crc ^= byte;
        for (int bit = 0; bit < 8; ++bit) {
            crc = (crc >> 1U) ^ (0xEDB88320U & (0U - (crc & 1U)));
        }
    }
    return ~crc;
}

std::uint32_t adler32(std::span<const std::uint8_t> bytes) {
    std::uint32_t first = 1;
    std::uint32_t second = 0;
    for (const auto byte : bytes) {
        first = (first + byte) % 65521U;
        second = (second + first) % 65521U;
    }
    return (second << 16U) | first;
}

void appendPngChunk(std::vector<std::uint8_t>& output, std::string_view type,
                    std::span<const std::uint8_t> payload) {
    appendBigEndian(output, static_cast<std::uint32_t>(payload.size()));
    const auto crcStart = output.size();
    output.insert(output.end(), type.begin(), type.end());
    output.insert(output.end(), payload.begin(), payload.end());
    appendBigEndian(output, crc32(std::span<const std::uint8_t>(output).subspan(crcStart)));
}

void writePng(const fs::path& path, int width, int height, std::span<const std::uint8_t> rgba) {
    std::vector<std::uint8_t> filtered;
    filtered.reserve(static_cast<std::size_t>((width * 4 + 1) * height));
    for (int y = height - 1; y >= 0; --y) {
        filtered.push_back(0);
        const auto offset = static_cast<std::size_t>(y * width * 4);
        filtered.insert(filtered.end(), rgba.begin() + static_cast<std::ptrdiff_t>(offset),
                        rgba.begin() + static_cast<std::ptrdiff_t>(offset + width * 4));
    }

    std::vector<std::uint8_t> compressed{0x78, 0x01};
    for (std::size_t offset = 0; offset < filtered.size();) {
        const auto length = static_cast<std::uint16_t>(
            std::min<std::size_t>(65535U, filtered.size() - offset));
        const bool final = offset + length == filtered.size();
        compressed.push_back(final ? 0x01 : 0x00);
        compressed.push_back(static_cast<std::uint8_t>(length & 0xFFU));
        compressed.push_back(static_cast<std::uint8_t>(length >> 8U));
        const auto inverted = static_cast<std::uint16_t>(~length);
        compressed.push_back(static_cast<std::uint8_t>(inverted & 0xFFU));
        compressed.push_back(static_cast<std::uint8_t>(inverted >> 8U));
        compressed.insert(compressed.end(), filtered.begin() + static_cast<std::ptrdiff_t>(offset),
                          filtered.begin() + static_cast<std::ptrdiff_t>(offset + length));
        offset += length;
    }
    appendBigEndian(compressed, adler32(filtered));

    std::vector<std::uint8_t> png{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    std::vector<std::uint8_t> header;
    appendBigEndian(header, static_cast<std::uint32_t>(width));
    appendBigEndian(header, static_cast<std::uint32_t>(height));
    header.insert(header.end(), {8, 6, 0, 0, 0});
    appendPngChunk(png, "IHDR", header);
    appendPngChunk(png, "IDAT", compressed);
    appendPngChunk(png, "IEND", {});

    if (!path.parent_path().empty()) fs::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary);
    stream.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
    if (!stream) throw std::runtime_error("failed to write screenshot");
}

void writePpm(const fs::path& path, int width, int height, std::span<const std::uint8_t> rgba) {
    if (!path.parent_path().empty()) fs::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary);
    stream << "P6\n" << width << ' ' << height << "\n255\n";
    for (int y = height - 1; y >= 0; --y) {
        for (int x = 0; x < width; ++x) {
            const auto offset = static_cast<std::size_t>((y * width + x) * 4);
            stream.write(reinterpret_cast<const char*>(rgba.data() + offset), 3);
        }
    }
    if (!stream) throw std::runtime_error("failed to write screenshot");
}

void captureScreenshot(const fs::path& path, int width, int height) {
    std::vector<std::uint8_t> rgba(static_cast<std::size_t>(width * height * 4));
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadBuffer(GL_BACK);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, rgba.data());
    auto extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    if (extension == ".png") writePng(path, width, height, rgba);
    else writePpm(path, width, height, rgba);
}

std::optional<std::vector<DesktopSessionTab>> parseTabs(const ResponseFrame& response) {
    if (response.error || !response.result) return std::nullopt;
    try {
        std::vector<DesktopSessionTab> tabs;
        for (const auto& item : response.result->at("tabs")) {
            tabs.push_back(DesktopSessionTab{item.at("path").get<std::string>(),
                                             item.at("title").get<std::string>(),
                                             item.at("cwd").get<std::string>(),
                                             item.at("active").get<bool>(),
                                             item.at("running").get<bool>(),
                                             item.at("unread").get<std::int64_t>(),
                                             item.at("draftDirty").get<bool>()});
        }
        return tabs;
    } catch (const nlohmann::json::exception&) {
        return std::nullopt;
    }
}

enum class ConnectionState { Connecting, Negotiating, Ready, Blocked };
enum class Activity { Explorer, Search, SourceControl, Terminal, Graph, Sessions };
enum class OmpUtility { Agents, Tasks };

std::string_view activityLabel(Activity activity) {
    switch (activity) {
        case Activity::Explorer: return "Explorer";
        case Activity::Search: return "Search";
        case Activity::SourceControl: return "Source Control";
        case Activity::Terminal: return "Terminal";
        case Activity::Graph: return "Graph";
        case Activity::Sessions: return "Sessions";
    }
    return {};
}


void drawActivityGlyph(Activity activity, ImDrawList* drawList, ImVec2 center, ImU32 color) {
    const float stroke = ui::metrics::stroke();
    const float left = center.x - ui::metrics::px(8.0F);
    const float top = center.y - ui::metrics::px(8.0F);
    const float right = center.x + ui::metrics::px(8.0F);
    const float bottom = center.y + ui::metrics::px(8.0F);
    const float radius = ui::metrics::px(3.0F);
    switch (activity) {
        case Activity::Explorer:
            drawList->AddRect({left + 2.0F, top}, {right - 1.0F, bottom}, color,
                              ui::metrics::px(1.5F), 0, stroke);
            drawList->AddLine({left + 2.0F, top + 4.0F}, {left - 1.0F, top + 4.0F},
                              color, stroke);
            drawList->AddLine({left - 1.0F, top + 4.0F}, {left - 1.0F, bottom + 1.0F},
                              color, stroke);
            break;
        case Activity::Search:
            drawList->AddCircle({center.x - 2.0F, center.y - 2.0F},
                                ui::metrics::px(5.5F), color, 24, stroke);
            drawList->AddLine({center.x + 2.0F, center.y + 2.0F},
                              {right, bottom}, color, stroke);
            break;
        case Activity::SourceControl:
            drawList->AddCircle({left + 3.0F, top + 2.0F}, radius, color, 16, stroke);
            drawList->AddCircle({right - 2.0F, center.y}, radius, color, 16, stroke);
            drawList->AddCircle({left + 3.0F, bottom - 2.0F}, radius, color, 16, stroke);
            drawList->AddLine({left + 3.0F, top + 5.0F},
                              {left + 3.0F, bottom - 5.0F}, color, stroke);
            drawList->AddBezierCubic({left + 3.0F, top + 6.0F},
                                     {left + 3.0F, center.y}, {right - 6.0F, center.y},
                                     {right - 5.0F, center.y}, color, stroke);
            break;
        case Activity::Terminal:
            drawList->AddRect({left, top + 1.0F}, {right, bottom - 1.0F}, color,
                              ui::metrics::px(2.0F), 0, stroke);
            drawList->AddLine({left + 4.0F, top + 5.0F}, {left + 7.0F, center.y},
                              color, stroke);
            drawList->AddLine({left + 7.0F, center.y}, {left + 4.0F, bottom - 5.0F},
                              color, stroke);
            drawList->AddLine({center.x, bottom - 5.0F}, {right - 4.0F, bottom - 5.0F},
                              color, stroke);
            break;
        case Activity::Graph:
            drawList->AddLine({left + 3.0F, center.y}, {right - 3.0F, top + 3.0F},
                              color, stroke);
            drawList->AddLine({left + 3.0F, center.y}, {right - 3.0F, bottom - 3.0F},
                              color, stroke);
            drawList->AddLine({right - 3.0F, top + 3.0F},
                              {right - 3.0F, bottom - 3.0F}, color, stroke);
            drawList->AddCircleFilled({left + 3.0F, center.y}, radius, color);
            drawList->AddCircleFilled({right - 3.0F, top + 3.0F}, radius, color);
            drawList->AddCircleFilled({right - 3.0F, bottom - 3.0F}, radius, color);
            break;
        case Activity::Sessions:
            for (int row = -1; row <= 1; ++row) {
                const float y = center.y + static_cast<float>(row) * ui::metrics::px(6.0F);
                drawList->AddCircleFilled({left + 2.0F, y}, ui::metrics::px(1.5F), color);
                drawList->AddLine({left + 6.0F, y}, {right, y}, color, stroke);
            }
            break;
    }
}

void drawActivityRail(Activity& selected, terminal::TerminalView& terminalView,
                      workspace::WorkspaceView& workspaceView, bool& ideOpen) {
    static constexpr std::array activities = {
        Activity::Explorer, Activity::Search, Activity::SourceControl,
        Activity::Terminal, Activity::Graph, Activity::Sessions,
    };
    for (const auto activity : activities) {
        ImGui::PushID(static_cast<int>(activity));
        const ImVec2 start = ImGui::GetCursorScreenPos();
        const ImVec2 size{ui::metrics::px(48.0F), ui::metrics::px(46.0F)};
        if (ImGui::InvisibleButton("##activity", size)) {
            selected = activity;
            ideOpen = true;
            if (activity == Activity::Terminal) terminalView.requestFocus();
            if (activity == Activity::Search) workspaceView.quickOpen();
        }
        const bool hovered = ImGui::IsItemHovered();
        const bool active = selected == activity;
        ImDrawList* drawList = ImGui::GetWindowDrawList();
        if (hovered) {
            drawList->AddRectFilled(start, {start.x + size.x, start.y + size.y},
                                    ui::toU32(ui::palette().buttonHovered));
        }
        if (active) {
            drawList->AddRectFilled(start, {start.x + ui::metrics::px(2.0F), start.y + size.y},
                                    ui::toU32(ui::palette().accent));
        }
        drawActivityGlyph(activity, drawList,
                          {start.x + size.x * 0.5F, start.y + size.y * 0.5F},
                          ui::toU32(active ? ui::palette().text : ui::palette().textDim));
        if (hovered) ImGui::SetTooltip("%s", activityLabel(activity).data());
        ImGui::PopID();
    }
}


void drawSessionTabs(copilot::CopilotView& copilotView, std::string_view cwd) {
    const auto tabs = copilotView.sessionTabs();
    static std::string pendingClose;
    const float stripHeight = ui::metrics::px(40.0F);
    const float actionWidth = ui::metrics::px(26.0F);
    const float tabWidth = std::min(ui::metrics::px(210.0F),
                                    std::max(ui::metrics::px(132.0F),
                                             ImGui::GetWindowWidth() * 0.34F));
    ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, ImVec2(0.0F, 0.0F));
    for (std::size_t index = 0; index < tabs.size(); ++index) {
        if (index != 0) ImGui::SameLine(0.0F, 0.0F);
        const auto& tab = tabs[index];
        ImGui::PushID(tab.path.c_str());
        ImGui::BeginGroup();
        const ImVec2 start = ImGui::GetCursorScreenPos();
        if (ImGui::InvisibleButton("##select", {tabWidth - actionWidth, stripHeight})) {
            copilotView.switchSession(tab.path);
        }
        const bool hovered = ImGui::IsItemHovered();
        ImGui::SameLine(0.0F, 0.0F);
        const char* action = tab.running ? "■" : "×";
        if (ImGui::InvisibleButton("##action", {actionWidth, stripHeight})) {
            if (tab.running) {
                if (!tab.active) copilotView.switchSession(tab.path);
                copilotView.stop();
            } else if (!copilotView.closeSession(tab.path)) {
                pendingClose = tab.path;
                ImGui::OpenPopup("Close session?");
            }
        }
        const bool actionHovered = ImGui::IsItemHovered();
        ImGui::EndGroup();

        ImDrawList* drawList = ImGui::GetWindowDrawList();
        const ImVec2 end{start.x + tabWidth, start.y + stripHeight};
        const ImVec4 background = tab.active ? ui::palette().tabActive
                                             : hovered ? ui::palette().buttonHovered
                                                       : ui::palette().tabBg;
        drawList->AddRectFilled(start, end, ui::toU32(background));
        drawList->AddLine({end.x, start.y}, end, ui::toU32(ui::palette().border));
        if (tab.active) {
            drawList->AddRectFilled({start.x, end.y - ui::metrics::px(2.0F)}, end,
                                    ui::toU32(ui::palette().accent));
        }
        if (actionHovered) {
            drawList->AddRectFilled({end.x - actionWidth, start.y}, end,
                                    ui::toU32(ui::palette().buttonActive));
        }
        const float textLeft = start.x + ui::metrics::px(8.0F);
        if (tab.running) {
            drawList->AddCircleFilled({textLeft + ui::metrics::px(3.0F),
                                       start.y + ui::metrics::px(14.0F)},
                                      ui::metrics::px(3.0F), ui::toU32(ui::palette().accent));
        }
        const float titleLeft = textLeft + (tab.running ? ui::metrics::px(10.0F) : 0.0F);
        const std::string title = tab.title.empty() ? "session" : tab.title;
        drawList->AddText({titleLeft, start.y + ui::metrics::px(5.0F)},
                          ui::toU32(tab.active ? ui::palette().text : ui::palette().textDim),
                          title.c_str());
        std::string meta = tab.running ? "running" : "idle";
        if (tab.unread > 0) meta += " · " + std::to_string(tab.unread) + " new";
        if (tab.draftDirty) meta += " · draft";
        drawList->AddText(ui::fonts().mono, ui::metrics::px(9.0F),
                          {textLeft, start.y + ui::metrics::px(23.0F)},
                          ui::toU32(ui::palette().textDim), meta.c_str());
        const ImVec2 actionSize = ImGui::CalcTextSize(action);
        drawList->AddText({end.x - actionWidth + (actionWidth - actionSize.x) * 0.5F,
                           start.y + (stripHeight - actionSize.y) * 0.5F},
                          ui::toU32(tab.running ? ui::palette().statusErr
                                                : ui::palette().textDim),
                          action);
        ImGui::PopID();
    }
    if (!tabs.empty()) ImGui::SameLine(0.0F, 0.0F);
    if (ImGui::Button("+##new-session", {ui::metrics::px(34.0F), stripHeight}) && !cwd.empty()) {
        copilotView.newSession(cwd);
    }
    ImGui::PopStyleVar();

    if (ImGui::BeginPopupModal("Close session?", nullptr, ImGuiWindowFlags_AlwaysAutoResize)) {
        ImGui::TextUnformatted("This session is running or has an unsent draft.");
        kit::dimText("Closing it discards the protected in-progress state.");
        if (kit::dangerButton("Close anyway")) {
            copilotView.closeSession(pendingClose, true);
            pendingClose.clear();
            ImGui::CloseCurrentPopup();
        }
        ImGui::SameLine();
        if (kit::secondaryButton("Cancel")) {
            pendingClose.clear();
            ImGui::CloseCurrentPopup();
        }
        ImGui::EndPopup();
    }
}

void drawSessionHeader(const DesktopStore& store, ConnectionState connectionState) {
    const SessionSnapshot* snapshot = store.activeSession();
    const SessionHeader* header =
        snapshot != nullptr && snapshot->header ? &*snapshot->header : nullptr;
    const SessionState* state =
        snapshot != nullptr && snapshot->state ? &*snapshot->state : nullptr;
    const std::string title =
        state != nullptr && state->sessionName ? *state->sessionName
        : header != nullptr && header->title ? *header->title
                                             : "session";
    const std::string cwd = state != nullptr ? state->cwd
                            : header != nullptr ? header->cwd
                                                : std::string{};

    ImGui::AlignTextToFramePadding();
    if (ui::fonts().medium != nullptr) ImGui::PushFont(ui::fonts().medium);
    ImGui::TextUnformatted(title.c_str());
    if (ui::fonts().medium != nullptr) ImGui::PopFont();
    if (!cwd.empty()) {
        ImGui::SameLine();
        if (ui::fonts().mono != nullptr) ImGui::PushFont(ui::fonts().mono);
        ImGui::TextColored(ui::palette().textDim, "%s", cwd.c_str());
        if (ui::fonts().mono != nullptr) ImGui::PopFont();
    }

    std::string model;
    std::string thinking;
    double contextPercent = 0.0;
    if (state != nullptr) {
        if (state->model) model = state->model->id;
        if (state->thinkingLevel) thinking = *state->thinkingLevel;
        if (state->contextUsage && state->contextUsage->percent)
            contextPercent = std::clamp(*state->contextUsage->percent, 0.0, 100.0);
    }
    const float rightReserve = ui::metrics::px(285.0F);
    ImGui::SameLine(std::max(ImGui::GetCursorPosX() + ui::metrics::px(8.0F),
                             ImGui::GetWindowWidth() - rightReserve));
    if (!model.empty()) {
        kit::chip(model.c_str(), kit::Tone::Neutral);
        ImGui::SameLine();
    }
    if (!thinking.empty()) {
        kit::chip(thinking.c_str(), kit::Tone::Neutral);
        ImGui::SameLine();
    }
    const ImVec2 gaugeStart = ImGui::GetCursorScreenPos();
    const float gaugeWidth = ui::metrics::px(42.0F);
    const float gaugeHeight = ui::metrics::px(3.0F);
    ImDrawList* drawList = ImGui::GetWindowDrawList();
    drawList->AddRectFilled({gaugeStart.x, gaugeStart.y + ui::metrics::px(9.0F)},
                            {gaugeStart.x + gaugeWidth,
                             gaugeStart.y + ui::metrics::px(9.0F) + gaugeHeight},
                            ui::toU32(ui::palette().gaugeTrack), gaugeHeight);
    drawList->AddRectFilled({gaugeStart.x, gaugeStart.y + ui::metrics::px(9.0F)},
                            {gaugeStart.x + gaugeWidth *
                                                static_cast<float>(contextPercent / 100.0),
                             gaugeStart.y + ui::metrics::px(9.0F) + gaugeHeight},
                            ui::toU32(ui::palette().gaugeFill), gaugeHeight);
    ImGui::Dummy({gaugeWidth, ImGui::GetFrameHeight()});
    ImGui::SameLine();
    ImGui::TextColored(ui::palette().textDim, "%.0f%%", contextPercent);
    ImGui::SameLine();
    const ImVec4 status = connectionState == ConnectionState::Ready
                              ? ui::palette().statusOk
                              : connectionState == ConnectionState::Blocked
                                    ? ui::palette().statusErr
                                    : ui::palette().statusWarn;
    const ImVec2 dot = ImGui::GetCursorScreenPos();
    drawList->AddCircleFilled({dot.x + ui::metrics::px(4.0F),
                               dot.y + ImGui::GetFrameHeight() * 0.5F},
                              ui::metrics::px(3.0F), ui::toU32(status));
    ImGui::Dummy({ui::metrics::px(10.0F), ImGui::GetFrameHeight()});
}

void routeShortcuts(Activity& activity, copilot::CopilotView& copilotView,
                    workspace::WorkspaceView& workspaceView,
                    terminal::TerminalView& terminalView, bool& ideOpen,
                    double& projectChordUntil) {
    const auto& io = ImGui::GetIO();
    if (io.WantTextInput) return;

    const auto focus = [&](Activity target) {
        activity = target;
        ideOpen = true;
        if (target == Activity::Terminal) terminalView.requestFocus();
        if (target == Activity::Search) workspaceView.quickOpen();
    };
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiMod_Shift | ImGuiKey_E)) focus(Activity::Explorer);
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiMod_Shift | ImGuiKey_F)) focus(Activity::Search);
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiMod_Shift | ImGuiKey_G)) focus(Activity::SourceControl);
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_GraveAccent)) focus(Activity::Terminal);

    const auto tabs = copilotView.sessionTabs();
    static constexpr std::array numberKeys = {
        ImGuiKey_1, ImGuiKey_2, ImGuiKey_3, ImGuiKey_4, ImGuiKey_5,
        ImGuiKey_6, ImGuiKey_7, ImGuiKey_8, ImGuiKey_9,
    };
    for (std::size_t index = 0; index < numberKeys.size() && index < tabs.size(); ++index) {
        if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | numberKeys[index])) {
            copilotView.switchSession(tabs[index].path);
        }
    }
    if (!tabs.empty() && ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_Tab)) {
        auto current = std::find_if(tabs.begin(), tabs.end(), [](const auto& tab) { return tab.active; });
        const std::size_t index = current == tabs.end()
                                      ? 0U
                                      : (static_cast<std::size_t>(current - tabs.begin()) + 1U) % tabs.size();
        copilotView.switchSession(tabs[index].path);
    }

    const double now = ImGui::GetTime();
    if (ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_K)) projectChordUntil = now + 1.25;
    if (projectChordUntil >= now &&
        (ImGui::IsKeyPressed(ImGuiKey_P) ||
         ImGui::IsKeyChordPressed(ImGuiMod_Shortcut | ImGuiKey_P))) {
        workspaceView.requestOpenFolder();
        projectChordUntil = 0.0;
    }
}

struct GlfwLifetime {
    ~GlfwLifetime() { glfwTerminate(); }
};

struct WindowLifetime {
    GLFWwindow* window = nullptr;
    ~WindowLifetime() {
        if (window != nullptr) glfwDestroyWindow(window);
    }
};

struct ImGuiLifetime {
    bool glfwBackend = false;
    bool openGlBackend = false;
    ~ImGuiLifetime() {
        if (openGlBackend) ImGui_ImplOpenGL3_Shutdown();
        if (glfwBackend) ImGui_ImplGlfw_Shutdown();
        if (ImGui::GetCurrentContext() != nullptr) ImGui::DestroyContext();
    }
};

}  // namespace

const char* usage() noexcept {
    return "Usage: chudcode-gui --url <ws://loopback:port> --token <bearer> [options]\n"
           "  --screenshot <file.ppm|file.png>  Capture once connected and settled\n"
           "  --width <pixels>                  Window width (minimum 800)\n"
           "  --project <path>                   Open this project after connecting\n"
           "  --frames <count>                  Bound rendering/capture frames\n"
           "  --reduced-motion                  Disable nonessential motion\n"
           "  --accessible-lists                Prefer keyboard-readable graph lists\n";
}

AppOptions parseOptions(int argc, const char* const* argv) {
    AppOptions options;
    options.url = environment("CHUDCODE_DESKTOP_URL");
    options.token = environment("CHUDCODE_DESKTOP_TOKEN");
    options.projectPath = environment("CHUDCODE_PROJECT");
    options.reducedMotion = environmentEnabled("CHUDCODE_REDUCED_MOTION");
    options.accessibleLists = environmentEnabled("CHUDCODE_ACCESSIBLE_LISTS");

    for (int index = 1; index < argc; ++index) {
        const std::string_view argument(argv[index]);
        if (argument == "--url" || argument.starts_with("--url=")) {
            options.url = optionValue(index, argc, argv, "--url");
        } else if (argument == "--token" || argument.starts_with("--token=")) {
            options.token = optionValue(index, argc, argv, "--token");
        } else if (argument == "--project" || argument.starts_with("--project=")) {
            options.projectPath = optionValue(index, argc, argv, "--project");
        } else if (argument == "--screenshot" || argument.starts_with("--screenshot=")) {
            options.screenshotPath = std::string(optionValue(index, argc, argv, "--screenshot"));
        } else if (argument == "--width" || argument.starts_with("--width=")) {
            options.width = static_cast<int>(parsePositive(optionValue(index, argc, argv, "--width"),
                                                           "--width", 8192));
        } else if (argument == "--height" || argument.starts_with("--height=")) {
            options.height = static_cast<int>(parsePositive(optionValue(index, argc, argv, "--height"),
                                                            "--height", 8192));
        } else if (argument == "--frames" || argument.starts_with("--frames=")) {
            options.frameLimit = parsePositive(optionValue(index, argc, argv, "--frames"),
                                               "--frames", 1'000'000);
        } else if (argument == "--reduced-motion") {
            options.reducedMotion = true;
        } else if (argument == "--accessible-lists") {
            options.accessibleLists = true;
        } else if (argument == "--help" || argument == "-h") {
            throw UsageError("help requested");
        } else {
            throw UsageError("unknown option: " + safeOptionName(argument));
        }
    }

    if (options.width < kMinimumWidth) throw UsageError("--width must be at least 800");
    if (options.height < kMinimumHeight) throw UsageError("--height must be at least 560");
    if (options.url.empty()) throw UsageError("--url is required (or set CHUDCODE_DESKTOP_URL)");
    if (options.token.empty()) throw UsageError("--token is required (or set CHUDCODE_DESKTOP_TOKEN)");
    if (options.token.find_first_of("\r\n") != std::string::npos) {
        throw UsageError("--token must not contain a line break");
    }
    if (options.screenshotPath && options.frameLimit == 0) {
        options.frameLimit = kDefaultScreenshotFrames;
    }
    return options;
}

int run(const AppOptions& options) {
    glfwSetErrorCallback([](int, const char* description) {
        if (description != nullptr) std::fputs("chudcode-gui: GLFW error\n", stderr);
    });
#if defined(GLFW_PLATFORM) && defined(GLFW_PLATFORM_X11)
    // Headless proof and isolated interaction tests use Xvfb. An inherited
    // WAYLAND_DISPLAY otherwise wins GLFW's platform selection even when
    // DISPLAY points at Xvfb.
    if ((options.screenshotPath || environmentEnabled("CHUDCODE_FORCE_X11")) &&
        std::getenv("DISPLAY") != nullptr) {
        glfwInitHint(GLFW_PLATFORM, GLFW_PLATFORM_X11);
    }
#endif
    if (glfwInit() != GLFW_TRUE) throw std::runtime_error("GLFW initialization failed");
    GlfwLifetime glfwLifetime;

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
#ifdef __APPLE__
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
#endif
#ifdef GLFW_X11_CLASS_NAME
    glfwWindowHintString(GLFW_X11_CLASS_NAME, "chudcode");
    glfwWindowHintString(GLFW_X11_INSTANCE_NAME, "chudcode");
#endif
#ifdef GLFW_WAYLAND_APP_ID
    glfwWindowHintString(GLFW_WAYLAND_APP_ID, "chudcode");
#endif

    WindowLifetime window{glfwCreateWindow(options.width, options.height, "Chudcode", nullptr, nullptr)};
    if (window.window == nullptr) throw std::runtime_error("window creation failed");
    glfwSetWindowSizeLimits(window.window, kMinimumWidth, kMinimumHeight, GLFW_DONT_CARE,
                            GLFW_DONT_CARE);
    glfwMakeContextCurrent(window.window);
    glfwSwapInterval(1);

    const auto assets = findAssets();
    setProductIcon(window.window, assets);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiLifetime imguiLifetime;
    auto& io = ImGui::GetIO();
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard | ImGuiConfigFlags_DockingEnable;
    const std::string iniPath = (dataDirectory() / "imgui.ini").string();
    io.IniFilename = iniPath.c_str();
    io.LogFilename = nullptr;

    float xScale = 1.0F;
    float yScale = 1.0F;
    glfwGetWindowContentScale(window.window, &xScale, &yScale);
    const float scale = std::clamp(std::max(xScale, yScale), 0.75F, 2.5F);
    io.Fonts->AddFontDefault();
    if (!assets.empty()) (void)ui::loadFonts(assets.string().c_str(), scale);
    ui::applyTheme(ui::Theme::Light, scale);
    anim::setMotionScale(options.reducedMotion ? 0.0F : 1.0F);

    if (!ImGui_ImplGlfw_InitForOpenGL(window.window, true)) {
        throw std::runtime_error("Dear ImGui GLFW backend initialization failed");
    }
    imguiLifetime.glfwBackend = true;
    if (!ImGui_ImplOpenGL3_Init("#version 330")) {
        throw std::runtime_error("Dear ImGui OpenGL backend initialization failed");
    }
    imguiLifetime.openGlBackend = true;

    WsTransport transport(WsTransportConfig{options.url, options.token});
    DesktopStore store;
    DesktopClient client(transport, store);
    editor::EditorPanel editor(editor::EditorRequests::forProtocolClient(client));
    workspace::WorkspaceView workspaceView(client, store, editor);
    GraphView graphView;
    graphView.setAccessibleFallback(options.accessibleLists);
    graphView.setOpenSourceCallback([&editor](const SourceLocation& location) { editor.open(location.uri); });
    vcs::VcsView vcsView(client, graphView);
    copilot::CopilotView copilotView(
        store, copilot::CopilotActions{[&client](std::string method, Json params,
                                                copilot::CopilotActions::Response response) {
            (void)client.request(std::move(method), std::move(params), std::move(response));
        }});

    std::unordered_map<std::string, std::vector<std::uint8_t>> terminalWrites;
    terminal::TerminalModels terminalModels(terminal::TerminalProtocolCallbacks{
        [&terminalWrites](std::string_view terminalId, std::span<const std::uint8_t> bytes) {
            auto& pending = terminalWrites[std::string(terminalId)];
            pending.insert(pending.end(), bytes.begin(), bytes.end());
        },
        [&client](std::string_view terminalId, int columns, int rows) {
            (void)client.request("terminal.resize",
                                 Json{{"terminalId", terminalId}, {"cols", columns}, {"rows", rows}});
        },
        [&client](std::string_view terminalId) {
            (void)client.request("terminal.close", Json{{"terminalId", terminalId}});
        },
    });
    terminal::TerminalView terminalView;

    std::unordered_map<std::string, std::string> terminalByWorkspace;
    std::unordered_set<std::string> terminalPending;
    std::string activeWorkspace;
    std::map<GraphKind, std::int64_t> graphRevisions;

    client.setEventHandler([&](const EventFrame& frame) {
        std::visit(
            [&](const auto& event) {
                using Event = std::decay_t<decltype(event)>;
                if constexpr (std::is_same_v<Event, TerminalDataEvent>) {
                    terminalModels.enqueueDataBase64(event.terminalId, event.dataBase64);
                } else if constexpr (std::is_same_v<Event, TerminalExitEvent>) {
                    terminalModels.enqueueExit(event.terminalId,
                                               event.exitCode ? std::optional<int>(static_cast<int>(*event.exitCode))
                                                              : std::nullopt,
                                               event.signal.value_or(std::string{}));
                } else if constexpr (std::is_same_v<Event, WorkspaceChangeEvent>) {
                    workspaceView.applyChanges(event.workspaceId, event.changes);
                } else if constexpr (std::is_same_v<Event, GraphEvent>) {
                    if (event.workspaceId == graphView.workspace()) graphView.update(event.kind, event.graph);
                }
            },
            frame.payload);
    });

    auto ensureTerminal = [&] {
        if (activeWorkspace.empty() || terminalByWorkspace.contains(activeWorkspace) ||
            terminalPending.contains(activeWorkspace)) {
            return;
        }
        const std::string workspaceId = activeWorkspace;
        terminalPending.insert(workspaceId);
        (void)client.request(
            "terminal.create", Json{{"workspaceId", workspaceId}, {"cols", 100}, {"rows", 24}},
            [&, workspaceId](const ResponseFrame& response) {
                terminalPending.erase(workspaceId);
                if (response.error || !response.result) return;
                try {
                    const auto terminalId = response.result->at("terminalId").get<std::string>();
                    if (terminalModels.find(terminalId) == nullptr) {
                        terminalModels.create(terminalId, workspaceId, 100, 24);
                    }
                    terminalByWorkspace[workspaceId] = terminalId;
                } catch (const nlohmann::json::exception&) {
                    return;
                }
            });
    };

    int bootstrapGeneration = 0;
    int bootstrapOutstanding = 0;
    ConnectionState connectionState = ConnectionState::Connecting;
    std::string blockedReason;
    auto bootstrap = [&] {
        const int generation = ++bootstrapGeneration;
        bootstrapOutstanding = 1;
        connectionState = ConnectionState::Negotiating;
        blockedReason.clear();
        (void)client.request(
            "runtime.hello", Json{{"protocol", kDesktopProtocolVersion}},
            [&, generation](const ResponseFrame& response) {
                if (generation != bootstrapGeneration) return;
                bootstrapOutstanding = 0;
                if (response.error || !response.result) {
                    connectionState = ConnectionState::Blocked;
                    blockedReason = response.error ? response.error->message : "runtime.hello returned no result";
                    return;
                }
                try {
                    const int protocol = response.result->at("protocol").get<int>();
                    const auto product = response.result->at("product").get<std::string>();
                    if (protocol != kDesktopProtocolVersion || product != kProduct) {
                        connectionState = ConnectionState::Blocked;
                        blockedReason = "The Bun desktop service uses an incompatible protocol.";
                        return;
                    }
                } catch (const nlohmann::json::exception&) {
                    connectionState = ConnectionState::Blocked;
                    blockedReason = "runtime.hello returned a malformed identity.";
                    return;
                }
                connectionState = ConnectionState::Ready;
                bootstrapOutstanding = 1;
                (void)client.request("session.tabs", Json::object(), [&, generation](const ResponseFrame& tabsResponse) {
                    if (generation != bootstrapGeneration) return;
                    --bootstrapOutstanding;
                    if (auto tabs = parseTabs(tabsResponse)) {
                        store.apply(EventFrame{SessionTabsEvent{std::move(*tabs)}});
                        if (store.activeSessionPath()) copilotView.setSessionPath(*store.activeSessionPath());
                        else if (!store.tabs().empty()) copilotView.setSessionPath(store.tabs().front().path);
                    }
                });
                workspaceView.refreshRecent();
                if (!options.projectPath.empty()) workspaceView.openProject(options.projectPath);
            });
    };

    client.start();
    bool wasConnected = false;
    Activity activity = Activity::Explorer;
    bool ideOpen = true;
    float ideWidth = ui::metrics::px(620.0F);
    OmpUtility ompUtility = OmpUtility::Agents;
    double projectChordUntil = 0.0;
    std::uint64_t renderedFrames = 0;
    std::uint64_t settledFrames = 0;
    bool screenshotWritten = false;
    bool animationFrame = true;

    while (glfwWindowShouldClose(window.window) == GLFW_FALSE) {
        glfwWaitEventsTimeout(animationFrame ? 0.05 : 0.10);
        client.drain();
        (void)terminalModels.processPending();
        workspaceView.syncFromStore();

        const bool connected = transport.connected();
        if (connected && !wasConnected) bootstrap();
        if (!connected && wasConnected) {
            ++bootstrapGeneration;
            bootstrapOutstanding = 0;
            connectionState = ConnectionState::Connecting;
            blockedReason.clear();
        }
        wasConnected = connected;

        if (const auto* descriptor = workspaceView.currentWorkspace();
            descriptor != nullptr && descriptor->id != activeWorkspace) {
            activeWorkspace = descriptor->id;
            editor.setWorkspace(activeWorkspace);
            graphView.setWorkspace(activeWorkspace);
            vcsView.setWorkspace(activeWorkspace);
            graphRevisions.clear();
            (void)client.request("git.snapshot", Json{{"workspaceId", activeWorkspace}});
            for (const auto kind : {"code", "git", "agent"}) {
                (void)client.request("graph.snapshot",
                                     Json{{"workspaceId", activeWorkspace}, {"kind", kind}});
            }
            ensureTerminal();
        }
        if (!activeWorkspace.empty()) {
            if (const auto* snapshot = store.workspace(activeWorkspace)) {
                vcsView.sync(snapshot->git);
                for (const auto& [kind, graph] : snapshot->graphs) {
                    const auto revision = graphRevisions.find(kind);
                    if (revision == graphRevisions.end() || revision->second != graph.revision) {
                        graphView.update(kind, graph);
                        graphRevisions[kind] = graph.revision;
                    }
                }
            }
        }

        if (store.activeSessionPath() && copilotView.sessionPath() != *store.activeSessionPath()) {
            copilotView.setSessionPath(*store.activeSessionPath());
        }

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();
        routeShortcuts(activity, copilotView, workspaceView, terminalView, ideOpen,
                       projectChordUntil);

        editor.processCallbacks();
        const float delta = anim::dt(io.DeltaTime);
        editor.advanceAnimations(delta);
        if (activity != Activity::Explorer && activity != Activity::Search) {
            workspaceView.advanceAnimations(delta);
        }
        if (activity != Activity::SourceControl) vcsView.advanceAnimations(delta);
        graphView.tick(delta);

        const ImGuiViewport* viewport = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(viewport->WorkPos);
        ImGui::SetNextWindowSize(viewport->WorkSize);
        ImGui::SetNextWindowViewport(viewport->ID);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.0F, 0.0F));
        ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0.0F);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0F);
        constexpr ImGuiWindowFlags shellFlags =
            ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoSavedSettings |
            ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoNavFocus;
        ImGui::Begin("Chudcode##shell", nullptr, shellFlags);
        ImGui::PopStyleVar(3);

        const float topHeight = ui::metrics::px(40.0F);
        const float statusHeight = ui::metrics::px(24.0F);
        const float bodyHeight =
            std::max(1.0F, ImGui::GetContentRegionAvail().y - topHeight - statusHeight);
        const WorkspaceDescriptor* descriptor = workspaceView.currentWorkspace();
        const std::string_view workspaceRoot =
            descriptor != nullptr ? std::string_view(descriptor->rootPath) : std::string_view{};

        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().headerBg);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {0.0F, 0.0F});
        ImGui::BeginChild("##topbar", {0.0F, topHeight}, ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_NoScrollbar);
        const float projectWidth =
            std::min(ui::metrics::px(380.0F), ImGui::GetContentRegionAvail().x * 0.45F);
        ImGui::BeginChild("##project-switcher", {projectWidth, 0.0F}, ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_NoScrollbar);
        workspaceView.drawProjectSwitcher(topHeight);
        ImGui::EndChild();
        ImGui::SameLine(0.0F, 0.0F);
        ImGui::BeginChild("##session-header", {0.0F, 0.0F}, ImGuiChildFlags_None,
                          ImGuiWindowFlags_NoScrollbar);
        ImGui::SetCursorPos({ui::metrics::px(12.0F),
                             std::max(0.0F, (topHeight - ImGui::GetFrameHeight()) * 0.5F)});
        drawSessionHeader(store, connectionState);
        ImGui::EndChild();
        ImGui::EndChild();
        ImGui::PopStyleVar();
        ImGui::PopStyleColor();
        ImGui::SetCursorPosY(ImGui::GetCursorPosY() - ImGui::GetStyle().ItemSpacing.y);

        const float availableWidth = ImGui::GetContentRegionAvail().x;
        const float railWidth = ui::metrics::px(48.0F);
        const float resizeWidth = ui::metrics::px(4.0F);
        const float maximumIdeWidth = std::min(
            ui::metrics::px(720.0F),
            std::max(ui::metrics::px(320.0F),
                     (availableWidth - railWidth - resizeWidth) * 0.44F));
        ideWidth = std::clamp(ideWidth, ui::metrics::px(320.0F), maximumIdeWidth);
        const bool showIde =
            ideOpen && availableWidth >= railWidth + resizeWidth +
                                            ui::metrics::px(680.0F);
        const float ompWidth =
            std::max(ui::metrics::px(360.0F),
                     availableWidth - railWidth - (showIde ? ideWidth + resizeWidth : 0.0F));

        ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {0.0F, 0.0F});
        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().headerBg);
        ImGui::BeginChild("##activity-rail", {railWidth, bodyHeight}, ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_NoScrollbar);
        drawActivityRail(activity, terminalView, workspaceView, ideOpen);
        ImGui::EndChild();
        ImGui::PopStyleColor();
        ImGui::PopStyleVar();
        ImGui::SameLine(0.0F, 0.0F);

        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().panelBg);
        ImGui::BeginChild("##omp-workspace", {ompWidth, bodyHeight}, ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_NoScrollbar);
        ImGui::PopStyleColor();
        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().headerBg);
        ImGui::BeginChild("##session-tabs", {0.0F, ui::metrics::px(40.0F)},
                          ImGuiChildFlags_Borders, ImGuiWindowFlags_HorizontalScrollbar);
        drawSessionTabs(copilotView, workspaceRoot);
        ImGui::EndChild();
        ImGui::PopStyleColor();
        ImGui::SetCursorPosY(ImGui::GetCursorPosY() - ImGui::GetStyle().ItemSpacing.y);

        std::size_t composerLines = 1U;
        if (!copilotView.sessionPath().empty()) {
            const auto& text = copilotView.draft().text.displayText();
            composerLines = std::clamp<std::size_t>(
                1U + static_cast<std::size_t>(std::count(text.begin(), text.end(), '\n')),
                1U, ui::metrics::kComposerMaxLines);
        }
        const float composerHeight = std::min(
            bodyHeight * 0.30F,
            ImGui::GetTextLineHeightWithSpacing() * static_cast<float>(composerLines + 1U) +
                ui::metrics::px(16.0F));
        const float ompMainHeight =
            std::max(1.0F, bodyHeight - ui::metrics::px(40.0F) - composerHeight);
        const float transcriptHeight = ompMainHeight * 0.64F;

        ImGui::BeginChild("##omp-transcript", {0.0F, transcriptHeight},
                          ImGuiChildFlags_Borders, ImGuiWindowFlags_NoScrollbar);
        ImGui::TextUnformatted("TRANSCRIPT");
        ImGui::SameLine(std::max(0.0F, ImGui::GetWindowWidth() -
                                          ui::metrics::px(36.0F)));
        ImGui::TextColored(connectionState == ConnectionState::Ready
                               ? ui::palette().statusOk
                               : ui::palette().statusWarn,
                           "%s", connectionState == ConnectionState::Ready ? "live" : "wait");
        ImGui::Separator();
        if (copilotView.sessionPath().empty()) {
            (void)kit::emptyState("No active session",
                                  "Select or create a session to begin using OMP.");
        } else {
            copilotView.drawTranscriptPanel({0.0F, 0.0F});
        }
        ImGui::EndChild();
        ImGui::SetCursorPosY(ImGui::GetCursorPosY() - ImGui::GetStyle().ItemSpacing.y);

        ImGui::BeginChild("##omp-utility", {0.0F, ompMainHeight - transcriptHeight},
                          ImGuiChildFlags_Borders, ImGuiWindowFlags_NoScrollbar);
        if (ImGui::Button("Agents", {ui::metrics::px(86.0F), ui::metrics::px(28.0F)})) {
            ompUtility = OmpUtility::Agents;
        }
        ImGui::SameLine();
        if (ImGui::Button("Tasks", {ui::metrics::px(86.0F), ui::metrics::px(28.0F)})) {
            ompUtility = OmpUtility::Tasks;
        }
        const bool agentsSelected = ompUtility == OmpUtility::Agents;
        ImGui::SameLine();
        const SessionSnapshot* activeSession = store.activeSession();
        const std::size_t count =
            agentsSelected
                ? (activeSession != nullptr ? activeSession->agents.size() : 0U)
                : copilotView.projection().tasks.size();
        ImGui::TextColored(ui::palette().textDim, "%zu", count);
        ImGui::Separator();
        if (agentsSelected) {
            copilotView.drawAgentsPanel({0.0F, 0.0F});
        } else {
            copilotView.drawTasksPanel({0.0F, 0.0F});
        }
        ImGui::EndChild();
        ImGui::SetCursorPosY(ImGui::GetCursorPosY() - ImGui::GetStyle().ItemSpacing.y);

        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().panelBg);
        ImGui::BeginChild("##composer-dock", {0.0F, composerHeight}, ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_NoScrollbar);
        if (copilotView.sessionPath().empty()) {
            (void)kit::emptyState("No active session",
                                  "Select or create a session before sending a prompt.");
        } else {
            copilotView.drawComposerPanel({0.0F, 0.0F});
        }
        ImGui::EndChild();
        ImGui::PopStyleColor();
        ImGui::EndChild();

        if (showIde) {
            ImGui::SameLine(0.0F, 0.0F);
            ImGui::BeginChild("##ide-resize", {resizeWidth, bodyHeight},
                              ImGuiChildFlags_None);
            ImGui::InvisibleButton("##drag", {-1.0F, -1.0F});
            if (ImGui::IsItemActive()) ideWidth -= ImGui::GetIO().MouseDelta.x;
            if (ImGui::IsItemHovered() || ImGui::IsItemActive()) {
                ImGui::GetWindowDrawList()->AddRectFilled(
                    ImGui::GetWindowPos(),
                    {ImGui::GetWindowPos().x + resizeWidth,
                     ImGui::GetWindowPos().y + bodyHeight},
                    ui::toU32(ui::palette().accent));
                ImGui::SetMouseCursor(ImGuiMouseCursor_ResizeEW);
            }
            ImGui::EndChild();
            ImGui::SameLine(0.0F, 0.0F);

            ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().editorGutterBg);
            ImGui::BeginChild("##ide-workspace", {ideWidth, bodyHeight},
                              ImGuiChildFlags_Borders, ImGuiWindowFlags_NoScrollbar);
            ImGui::PopStyleColor();
            ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().headerBg);
            ImGui::BeginChild("##ide-heading", {0.0F, ui::metrics::px(34.0F)},
                              ImGuiChildFlags_Borders, ImGuiWindowFlags_NoScrollbar);
            ImGui::TextUnformatted(activityLabel(activity).data());
            ImGui::SameLine(std::max(0.0F, ImGui::GetWindowWidth() -
                                              ui::metrics::px(26.0F)));
            if (ImGui::SmallButton("×##close-ide")) ideOpen = false;
            ImGui::EndChild();
            ImGui::PopStyleColor();
            ImGui::SetCursorPosY(ImGui::GetCursorPosY() - ImGui::GetStyle().ItemSpacing.y);

            ImGui::BeginChild("##ide-content", {0.0F, 0.0F}, ImGuiChildFlags_None,
                              ImGuiWindowFlags_NoScrollbar);
            if (connectionState == ConnectionState::Blocked) {
                if (kit::blockedState("Desktop service blocked", blockedReason.c_str(), "Retry") &&
                    connected) {
                    bootstrap();
                }
            } else if (activeWorkspace.empty()) {
                if (kit::emptyState("Open a project",
                                    "Choose a recent project or open a folder to begin.",
                                    "Open Folder")) {
                    workspaceView.requestOpenFolder();
                }
            } else if (activity == Activity::SourceControl) {
                vcsView.draw("##vcs-view", {0.0F, 0.0F});
            } else if (activity == Activity::Graph) {
                (void)graphView.draw("##graph-view", {0.0F, 0.0F});
            } else if (activity == Activity::Terminal) {
                ensureTerminal();
                const auto terminal = terminalByWorkspace.find(activeWorkspace);
                if (terminal == terminalByWorkspace.end()) {
                    if (terminalPending.contains(activeWorkspace)) {
                        kit::spinner("Starting terminal");
                    } else if (kit::emptyState("Terminal unavailable",
                                               "The terminal is not running.", "Start")) {
                        ensureTerminal();
                    }
                } else {
                    (void)terminalView.draw(terminalModels, terminal->second, {0.0F, 0.0F});
                }
            } else if (activity == Activity::Sessions) {
                copilotView.drawSessionsPanel({0.0F, 0.0F});
            } else if (ImGui::BeginTable("##explorer-editor", 2,
                                         ImGuiTableFlags_Resizable |
                                             ImGuiTableFlags_BordersInnerV,
                                         {0.0F, 0.0F})) {
                const float explorerWidth =
                    std::min(ui::metrics::px(240.0F), ImGui::GetContentRegionAvail().x * 0.44F);
                ImGui::TableSetupColumn("Explorer", ImGuiTableColumnFlags_WidthFixed,
                                        explorerWidth);
                ImGui::TableSetupColumn("Editor", ImGuiTableColumnFlags_WidthStretch);
                ImGui::TableNextRow();
                ImGui::TableSetColumnIndex(0);
                workspaceView.draw("##workspace-view", 0.0F, 0.0F, false);
                ImGui::TableSetColumnIndex(1);
                editor.draw("##editor", 0.0F, 0.0F);
                ImGui::EndTable();
            }
            ImGui::EndChild();
            ImGui::EndChild();
        }

        ImGui::SetCursorPosY(ImGui::GetCursorPosY() - ImGui::GetStyle().ItemSpacing.y);
        ImGui::PushStyleColor(ImGuiCol_ChildBg, ui::palette().statusBg);
        ImGui::BeginChild("##status-bar", {0.0F, statusHeight}, ImGuiChildFlags_Borders,
                          ImGuiWindowFlags_NoScrollbar);
        if (connectionState == ConnectionState::Ready) {
            ImGui::TextColored(ui::palette().statusOk, "Live");
        } else if (connectionState == ConnectionState::Blocked) {
            ImGui::TextColored(ui::palette().statusErr, "Blocked");
        } else {
            ImGui::TextColored(ui::palette().statusWarn,
                               connected ? "Negotiating" : "Reconnecting");
        }
        if (descriptor != nullptr) {
            ImGui::SameLine();
            if (ui::fonts().mono != nullptr) ImGui::PushFont(ui::fonts().mono);
            ImGui::TextColored(ui::palette().textDim, "%s", descriptor->rootPath.c_str());
            if (ui::fonts().mono != nullptr) ImGui::PopFont();
        }
        ImGui::SameLine(std::max(ImGui::GetCursorPosX() + ui::metrics::px(8.0F),
                                 ImGui::GetWindowWidth() - ui::metrics::px(72.0F)));
        if (ImGui::SmallButton(showIde ? "Close IDE" : "IDE")) {
            ideOpen = !ideOpen;
        }
        ImGui::EndChild();
        ImGui::PopStyleColor();
        ImGui::End();

        for (auto& [terminalId, bytes] : terminalWrites) {
            if (bytes.empty()) continue;
            const std::string data(reinterpret_cast<const char*>(bytes.data()), bytes.size());
            (void)client.request("terminal.write",
                                 Json{{"terminalId", terminalId}, {"data", data}});
        }
        terminalWrites.clear();

        ImGui::Render();
        int framebufferWidth = 0;
        int framebufferHeight = 0;
        glfwGetFramebufferSize(window.window, &framebufferWidth, &framebufferHeight);
        glViewport(0, 0, framebufferWidth, framebufferHeight);
        const auto background = ui::palette().windowBg;
        glClearColor(background.x, background.y, background.z, background.w);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());

        ++renderedFrames;
        const bool settled = connected && connectionState == ConnectionState::Ready &&
                             bootstrapOutstanding == 0 && client.pendingCount() == 0;
        settledFrames = settled ? settledFrames + 1U : 0U;
        const bool bounded = options.frameLimit > 0 && renderedFrames >= options.frameLimit;
        if (options.screenshotPath && !screenshotWritten && (settledFrames >= 6U || bounded)) {
            captureScreenshot(*options.screenshotPath, framebufferWidth, framebufferHeight);
            screenshotWritten = true;
            glfwSetWindowShouldClose(window.window, GLFW_TRUE);
        } else if (!options.screenshotPath && bounded) {
            glfwSetWindowShouldClose(window.window, GLFW_TRUE);
        }

        glfwSwapBuffers(window.window);
        animationFrame = anim::consumeFrameRequest();
    }

    client.stop();
    return 0;
}

}  // namespace chud::app
