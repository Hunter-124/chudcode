#ifndef CHUDCODE_TUI_H
#define CHUDCODE_TUI_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Row-granular differential frame emitter.
 *
 * The screen owns the bytes of the last emitted frame. Each frame stages rows,
 * then `chudcode_tui_flush` emits absolute cursor positioning plus the bytes of only
 * the rows that changed. Rows are opaque byte strings: the caller is
 * responsible for padding, clipping, and style termination, so this core needs
 * no Unicode width tables, no SGR parser, and no allocator churn per frame.
 *
 * Cursor position after a flush is unspecified. Callers that require a specific
 * final position append the sequence to `epilogue`.
 */

typedef struct ChudTuiScreen ChudTuiScreen;

typedef struct ChudTuiSlice {
	const uint8_t *data;
	size_t length;
} ChudTuiSlice;

int chudcode_tui_create(ChudTuiScreen **out, char *error, size_t error_capacity);
void chudcode_tui_destroy(ChudTuiScreen *screen);

/* Stage a frame of `rows` rows. A row-count change forces a full repaint. */
int chudcode_tui_begin_frame(ChudTuiScreen *screen, size_t rows, char *error, size_t error_capacity);
int chudcode_tui_set_row(
	ChudTuiScreen *screen,
	size_t row,
	const uint8_t *bytes,
	size_t length,
	char *error,
	size_t error_capacity
);
/* Treat every row of the next flush as changed. */
int chudcode_tui_force_repaint(ChudTuiScreen *screen);

/*
 * Emit the staged frame. When no row changed and no repaint is forced the
 * output is empty so the caller can skip the write entirely.
 */
int chudcode_tui_flush(
	ChudTuiScreen *screen,
	const uint8_t *prologue,
	size_t prologue_length,
	const uint8_t *epilogue,
	size_t epilogue_length,
	ChudTuiSlice *out,
	char *error,
	size_t error_capacity
);

size_t chudcode_tui_rows(const ChudTuiScreen *screen);
/* Rows emitted by the most recent flush. */
size_t chudcode_tui_changed_rows(const ChudTuiScreen *screen);

#ifdef __cplusplus
}
#endif

#endif
