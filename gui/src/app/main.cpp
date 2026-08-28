#include "app/app.h"

#include <exception>
#include <iostream>

int main(int argc, char** argv) {
    try {
        return chud::app::run(chud::app::parseOptions(argc, argv));
    } catch (const chud::app::UsageError& error) {
        std::cerr << "chudcode-gui: " << error.what() << '\n' << chud::app::usage();
        return 2;
    } catch (const std::exception& error) {
        std::cerr << "chudcode-gui: " << error.what() << '\n';
        return 1;
    }
}
