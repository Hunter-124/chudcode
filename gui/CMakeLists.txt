cmake_minimum_required(VERSION 3.24)
project(chudcode_gui VERSION 0.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

include(FetchContent)
find_package(OpenGL REQUIRED)
find_package(Threads REQUIRED)

set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(glfw GIT_REPOSITORY https://github.com/glfw/glfw.git GIT_TAG 3.4 GIT_SHALLOW TRUE)
FetchContent_Declare(json GIT_REPOSITORY https://github.com/nlohmann/json.git GIT_TAG v3.11.3 GIT_SHALLOW TRUE)
FetchContent_Declare(imgui GIT_REPOSITORY https://github.com/ocornut/imgui.git GIT_TAG v1.92.9-docking GIT_SHALLOW TRUE)
set(USE_TLS OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(BUILD_DEMO OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(ixwebsocket GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git GIT_TAG v12.0.1 GIT_SHALLOW TRUE)

FetchContent_Declare(texteditor GIT_REPOSITORY https://github.com/goossens/ImGuiColorTextEdit.git GIT_TAG a20e4493bb618a8b738bbb33e00932f842ae8595)
FetchContent_Declare(libvterm GIT_REPOSITORY https://github.com/neovim/libvterm.git GIT_TAG 934bc2fbf21800ac3458a499df8820ca5fb45fd3)

FetchContent_MakeAvailable(glfw imgui json ixwebsocket)
FetchContent_GetProperties(texteditor)
if(NOT texteditor_POPULATED)
  FetchContent_Populate(texteditor)
endif()
FetchContent_GetProperties(libvterm)
if(NOT libvterm_POPULATED)
  FetchContent_Populate(libvterm)
endif()

add_library(chud_imgui STATIC
  ${imgui_SOURCE_DIR}/imgui.cpp
  ${imgui_SOURCE_DIR}/imgui_draw.cpp
  ${imgui_SOURCE_DIR}/imgui_tables.cpp
  ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp)
target_include_directories(chud_imgui PUBLIC ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(chud_imgui PUBLIC glfw OpenGL::GL)
add_library(chud_editor_vendor STATIC ${texteditor_SOURCE_DIR}/TextEditor.cpp ${texteditor_SOURCE_DIR}/TextDiff.cpp)
file(GLOB VTERM_SOURCES CONFIGURE_DEPENDS ${libvterm_SOURCE_DIR}/src/*.c)
add_library(chud_vterm STATIC ${VTERM_SOURCES})
target_include_directories(chud_vterm PUBLIC ${libvterm_SOURCE_DIR}/include PRIVATE ${libvterm_SOURCE_DIR}/src)
set_target_properties(chud_vterm PROPERTIES C_STANDARD 99 C_STANDARD_REQUIRED ON)

target_include_directories(chud_editor_vendor PUBLIC ${texteditor_SOURCE_DIR})
target_link_libraries(chud_editor_vendor PUBLIC chud_imgui)

add_library(chud_ui_foundation STATIC
  src/theme/theme.cpp src/theme/anim.cpp src/widgets/kit.cpp)
target_include_directories(chud_ui_foundation PUBLIC src)
target_link_libraries(chud_ui_foundation PUBLIC chud_imgui)

add_library(chud_icons STATIC src/icons/icons.cpp)
target_include_directories(chud_icons PUBLIC src)
target_link_libraries(chud_icons PUBLIC chud_imgui nlohmann_json::nlohmann_json)

# Shared headless dependencies for native GUI tests. Keep icon loading free of
# GLFW/OpenGL so every consumer can exercise atlas metadata without a display.
add_library(chud_gui_tests INTERFACE)
target_link_libraries(chud_gui_tests INTERFACE chud_icons)

add_library(chud_protocol STATIC
  src/protocol/json_codec.cpp src/protocol/desktop_store.cpp src/protocol/desktop_client.cpp src/net/ws_transport.cpp)
target_include_directories(chud_protocol PUBLIC src)
target_link_libraries(chud_protocol PUBLIC nlohmann_json::nlohmann_json ixwebsocket::ixwebsocket Threads::Threads)

add_library(chud_editor STATIC src/editor/editor.cpp)
target_include_directories(chud_editor PUBLIC src)
target_link_libraries(chud_editor PUBLIC chud_editor_vendor chud_protocol chud_ui_foundation)

add_library(chud_terminal STATIC src/terminal/base64.cpp src/terminal/terminal_model.cpp src/terminal/terminal_view.cpp)
target_include_directories(chud_terminal PUBLIC src)
target_link_libraries(chud_terminal PUBLIC chud_vterm chud_protocol chud_ui_foundation)

add_library(chud_workspace STATIC src/workspace/workspace_view.cpp)
target_include_directories(chud_workspace PUBLIC src)
target_link_libraries(chud_workspace PUBLIC chud_protocol chud_editor chud_ui_foundation)

add_library(chud_vcs STATIC src/vcs/diff_model.cpp src/vcs/vcs_view.cpp)
target_include_directories(chud_vcs PUBLIC src)
target_link_libraries(chud_vcs PUBLIC chud_protocol chud_editor chud_ui_foundation)

add_library(chud_graph STATIC src/graph/force_graph.cpp src/graph/graph_view.cpp)
target_include_directories(chud_graph PUBLIC src)
target_link_libraries(chud_graph PUBLIC chud_protocol chud_ui_foundation)

add_library(chud_copilot STATIC
  src/copilot/copilot_view.cpp src/copilot/image_textures.cpp)
target_include_directories(chud_copilot PUBLIC src)
# Vendored stb_image v2.30 (third_party/stb, MIT OR public domain; license
# text at the end of the header) decodes draft-attachment thumbnails.
target_include_directories(chud_copilot PRIVATE third_party)
target_link_libraries(chud_copilot PUBLIC chud_protocol chud_editor chud_ui_foundation chud_icons)

add_library(chud_session_dag STATIC
  src/graph/session_dag.cpp src/graph/session_dag_view.cpp)
target_include_directories(chud_session_dag PUBLIC src)
target_link_libraries(chud_session_dag PUBLIC chud_copilot chud_graph chud_ui_foundation)

add_executable(chudcode-gui src/app/app.cpp src/app/main.cpp)
target_link_libraries(chudcode-gui PRIVATE chud_workspace chud_editor chud_terminal chud_vcs chud_graph chud_copilot chud_session_dag chud_icons chud_ui_foundation chud_protocol)
add_custom_command(TARGET chudcode-gui POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    ${CMAKE_CURRENT_SOURCE_DIR}/assets
    $<TARGET_FILE_DIR:chudcode-gui>/assets)

include(CTest)
if(BUILD_TESTING)
  add_executable(test_protocol tests/test_protocol.cpp)
  target_link_libraries(test_protocol PRIVATE chud_protocol)
  add_test(NAME protocol COMMAND test_protocol)

  add_executable(test_editor tests/test_editor.cpp)
  target_link_libraries(test_editor PRIVATE chud_editor)
  add_test(NAME editor COMMAND test_editor)

  add_executable(test_terminal tests/test_terminal.cpp)
  target_link_libraries(test_terminal PRIVATE chud_terminal)
  add_test(NAME terminal COMMAND test_terminal)

  add_executable(test_graph tests/test_graph.cpp)
  target_link_libraries(test_graph PRIVATE chud_graph)

  add_executable(test_workspace tests/test_workspace.cpp)
  target_link_libraries(test_workspace PRIVATE chud_workspace)
  add_test(NAME workspace COMMAND test_workspace)

  add_executable(test_vcs tests/test_vcs.cpp)
  target_link_libraries(test_vcs PRIVATE chud_vcs)
  add_test(NAME vcs COMMAND test_vcs)

  add_executable(test_copilot tests/test_copilot.cpp)
  target_link_libraries(test_copilot PRIVATE chud_copilot)
  add_test(NAME copilot COMMAND test_copilot)
  add_test(NAME graph COMMAND test_graph)

  add_executable(test_session_dag tests/test_session_dag.cpp)
  target_link_libraries(test_session_dag PRIVATE chud_session_dag)
  add_test(NAME session_dag COMMAND test_session_dag)

  add_executable(test_icons tests/test_icons.cpp)
  target_link_libraries(test_icons PRIVATE chud_gui_tests)
  add_test(NAME icons COMMAND test_icons ${CMAKE_CURRENT_SOURCE_DIR}/assets)

  add_executable(test_theme tests/test_theme.cpp)
  target_link_libraries(test_theme PRIVATE chud_ui_foundation nlohmann_json::nlohmann_json)
  add_test(NAME theme COMMAND test_theme ${CMAKE_CURRENT_SOURCE_DIR}/..)

  add_executable(test_app_ini tests/test_app_ini.cpp)
  target_compile_definitions(test_app_ini PRIVATE
    CHUDCODE_GUI_VERSION="${PROJECT_VERSION}")
  add_dependencies(test_app_ini chudcode-gui)
  find_program(XVFB_RUN_EXECUTABLE xvfb-run)
  if(XVFB_RUN_EXECUTABLE)
    add_test(NAME app_ini COMMAND ${XVFB_RUN_EXECUTABLE} -a
      $<TARGET_FILE:test_app_ini> $<TARGET_FILE:chudcode-gui>)
  else()
    add_test(NAME app_ini COMMAND $<TARGET_FILE:test_app_ini>
      $<TARGET_FILE:chudcode-gui>)
  endif()
  set_tests_properties(app_ini PROPERTIES TIMEOUT 30
    ENVIRONMENT "LIBGL_ALWAYS_SOFTWARE=1")
endif()
