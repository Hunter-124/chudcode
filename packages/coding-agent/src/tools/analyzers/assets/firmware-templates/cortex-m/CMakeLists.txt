cmake_minimum_required(VERSION 3.16)

# Keep the compilation database available to clangd and the analyzer tools.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON CACHE BOOL "" FORCE)
project(firmware C ASM)

set(CMAKE_C_STANDARD 11)
set(MCU_FLAGS "-mcpu=cortex-m3;-mthumb" CACHE STRING "Cortex-M architecture flags")

add_compile_options(
    ${MCU_FLAGS}
    -ffunction-sections
    -fdata-sections
    -Wall
    -Wextra
    -Og
    -g
)

add_link_options(
    ${MCU_FLAGS}
    -nostdlib
    -T${CMAKE_CURRENT_SOURCE_DIR}/linker.ld
    -Wl,--gc-sections
    -Wl,-Map=${CMAKE_PROJECT_NAME}.map
)

add_executable(${CMAKE_PROJECT_NAME}.elf
    src/main.c
    src/startup.c
)
set_target_properties(${CMAKE_PROJECT_NAME}.elf PROPERTIES
    LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/linker.ld
)
