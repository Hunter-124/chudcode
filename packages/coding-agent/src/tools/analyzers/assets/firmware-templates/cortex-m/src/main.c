#include <stdint.h>

static void semihost_write0(const char *text)
{
    register uint32_t operation __asm__("r0") = 4u;
    register const char *argument __asm__("r1") = text;
    __asm__ volatile("bkpt 0xab" : "+r"(operation) : "r"(argument) : "memory");
}

int main(void)
{
    semihost_write0("hello from cortex-m firmware\n");
    for (;;) {
        __asm__ volatile("wfi");
    }
}
