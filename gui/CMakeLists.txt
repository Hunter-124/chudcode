cmake_minimum_required(VERSION 3.24)
project(omp-gui LANGUAGES CXX)

include(FetchContent)
include(CTest)

set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GLFW_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  glfw
  GIT_REPOSITORY https://github.com/glfw/glfw.git
  GIT_TAG 3.4
  GIT_SHALLOW TRUE
)

FetchContent_Declare(
  imgui
  GIT_REPOSITORY https://github.com/ocornut/imgui.git
  GIT_TAG v1.91.6-docking
  GIT_SHALLOW TRUE
)

FetchContent_MakeAvailable(glfw imgui)
find_package(OpenGL REQUIRED)

add_executable(omp-gui
  src/main.cpp
  src/theme.cpp
  src/kit.cpp
  src/fixture.cpp
  src/panels.cpp
  src/text_wrap.cpp
  ${imgui_SOURCE_DIR}/imgui.cpp
  ${imgui_SOURCE_DIR}/imgui_draw.cpp
  ${imgui_SOURCE_DIR}/imgui_tables.cpp
  ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
  ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp
)

target_compile_features(omp-gui PRIVATE cxx_std_17)
target_include_directories(omp-gui PRIVATE
  src
  ${imgui_SOURCE_DIR}
  ${imgui_SOURCE_DIR}/backends
)
target_link_libraries(omp-gui PRIVATE glfw OpenGL::GL)

if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  target_compile_options(omp-gui PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(BUILD_TESTING)
  add_executable(omp-gui-wrap-test
    tests/text_wrap_test.cpp
    src/fixture.cpp
    src/text_wrap.cpp
    ${imgui_SOURCE_DIR}/imgui.cpp
    ${imgui_SOURCE_DIR}/imgui_draw.cpp
    ${imgui_SOURCE_DIR}/imgui_tables.cpp
    ${imgui_SOURCE_DIR}/imgui_widgets.cpp
  )
  target_compile_features(omp-gui-wrap-test PRIVATE cxx_std_17)
  target_include_directories(omp-gui-wrap-test PRIVATE src ${imgui_SOURCE_DIR})
  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(omp-gui-wrap-test PRIVATE -Wall -Wextra -Wpedantic)
  endif()
  add_test(NAME omp-gui-wrap-round-trip COMMAND omp-gui-wrap-test)
endif()
