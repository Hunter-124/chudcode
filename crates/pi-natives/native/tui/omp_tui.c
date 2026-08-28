#include "omp_tui.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct OmpTuiRow {
	uint8_t *bytes;
	size_t length;
	size_t capacity;
} OmpTuiRow;

struct OmpTuiScreen {
	OmpTuiRow *front;
	OmpTuiRow *back;
	uint8_t *staged;
	size_t rows;
	size_t rows_capacity;
	int force_repaint;
	uint8_t *out;
	size_t out_length;
	size_t out_capacity;
	size_t changed_rows;
};

static void set_error(char *error, size_t capacity, const char *format, ...) {
	va_list arguments;
	if (error == NULL || capacity == 0) {
		return;
	}
	va_start(arguments, format);
	(void)vsnprintf(error, capacity, format, arguments);
	va_end(arguments);
	error[capacity - 1] = '\0';
}

static int reserve_row(OmpTuiRow *row, size_t length) {
	uint8_t *grown;
	size_t capacity;
	if (row->capacity >= length) {
		return 0;
	}
	capacity = row->capacity == 0 ? 64u : row->capacity;
	while (capacity < length) {
		if (capacity > SIZE_MAX / 2u) {
			return -1;
		}
		capacity *= 2u;
	}
	grown = (uint8_t *)realloc(row->bytes, capacity);
	if (grown == NULL) {
		return -1;
	}
	row->bytes = grown;
	row->capacity = capacity;
	return 0;
}

static int reserve_output(OmpTuiScreen *screen, size_t additional) {
	uint8_t *grown;
	size_t required;
	size_t capacity;
	if (screen->out_length > SIZE_MAX - additional) {
		return -1;
	}
	required = screen->out_length + additional;
	if (screen->out_capacity >= required) {
		return 0;
	}
	capacity = screen->out_capacity == 0 ? 4096u : screen->out_capacity;
	while (capacity < required) {
		if (capacity > SIZE_MAX / 2u) {
			return -1;
		}
		capacity *= 2u;
	}
	grown = (uint8_t *)realloc(screen->out, capacity);
	if (grown == NULL) {
		return -1;
	}
	screen->out = grown;
	screen->out_capacity = capacity;
	return 0;
}

static int append_output(OmpTuiScreen *screen, const uint8_t *bytes, size_t length) {
	if (length == 0) {
		return 0;
	}
	if (reserve_output(screen, length) != 0) {
		return -1;
	}
	memcpy(screen->out + screen->out_length, bytes, length);
	screen->out_length += length;
	return 0;
}

/* Emit `ESC [ <row+1> ; 1 H` without touching printf at frame time. */
static int append_cursor_row(OmpTuiScreen *screen, size_t row) {
	uint8_t sequence[32];
	uint8_t digits[20];
	size_t digit_count = 0;
	size_t length = 0;
	size_t line = row + 1u;

	do {
		digits[digit_count++] = (uint8_t)('0' + (line % 10u));
		line /= 10u;
	} while (line != 0);

	sequence[length++] = 0x1b;
	sequence[length++] = '[';
	while (digit_count > 0) {
		sequence[length++] = digits[--digit_count];
	}
	sequence[length++] = ';';
	sequence[length++] = '1';
	sequence[length++] = 'H';
	return append_output(screen, sequence, length);
}

static int resize_rows(OmpTuiScreen *screen, size_t rows) {
	OmpTuiRow *front;
	OmpTuiRow *back;
	uint8_t *staged;
	size_t index;

	if (rows <= screen->rows_capacity) {
		return 0;
	}
	if (rows > SIZE_MAX / sizeof(OmpTuiRow)) {
		return -1;
	}
	front = (OmpTuiRow *)realloc(screen->front, rows * sizeof(OmpTuiRow));
	if (front == NULL) {
		return -1;
	}
	screen->front = front;
	back = (OmpTuiRow *)realloc(screen->back, rows * sizeof(OmpTuiRow));
	if (back == NULL) {
		return -1;
	}
	screen->back = back;
	staged = (uint8_t *)realloc(screen->staged, rows);
	if (staged == NULL) {
		return -1;
	}
	screen->staged = staged;
	for (index = screen->rows_capacity; index < rows; index += 1u) {
		screen->front[index].bytes = NULL;
		screen->front[index].length = 0;
		screen->front[index].capacity = 0;
		screen->back[index].bytes = NULL;
		screen->back[index].length = 0;
		screen->back[index].capacity = 0;
		screen->staged[index] = 0;
	}
	screen->rows_capacity = rows;
	return 0;
}

int omp_tui_create(OmpTuiScreen **out, char *error, size_t error_capacity) {
	OmpTuiScreen *screen;
	if (out == NULL) {
		set_error(error, error_capacity, "screen output handle pointer is null");
		return -1;
	}
	*out = NULL;
	screen = (OmpTuiScreen *)calloc(1u, sizeof(OmpTuiScreen));
	if (screen == NULL) {
		set_error(error, error_capacity, "could not allocate screen");
		return -1;
	}
	screen->force_repaint = 1;
	*out = screen;
	return 0;
}

void omp_tui_destroy(OmpTuiScreen *screen) {
	size_t index;
	if (screen == NULL) {
		return;
	}
	for (index = 0; index < screen->rows_capacity; index += 1u) {
		free(screen->front[index].bytes);
		free(screen->back[index].bytes);
	}
	free(screen->front);
	free(screen->back);
	free(screen->staged);
	free(screen->out);
	free(screen);
}

int omp_tui_begin_frame(OmpTuiScreen *screen, size_t rows, char *error, size_t error_capacity) {
	size_t index;
	if (screen == NULL) {
		set_error(error, error_capacity, "screen handle is null");
		return -1;
	}
	if (resize_rows(screen, rows) != 0) {
		set_error(error, error_capacity, "could not allocate %zu screen rows", rows);
		return -1;
	}
	if (rows != screen->rows) {
		screen->force_repaint = 1;
		screen->rows = rows;
	}
	for (index = 0; index < rows; index += 1u) {
		screen->staged[index] = 0;
		screen->back[index].length = 0;
	}
	return 0;
}

int omp_tui_set_row(
	OmpTuiScreen *screen,
	size_t row,
	const uint8_t *bytes,
	size_t length,
	char *error,
	size_t error_capacity
) {
	if (screen == NULL) {
		set_error(error, error_capacity, "screen handle is null");
		return -1;
	}
	if (row >= screen->rows) {
		set_error(error, error_capacity, "row %zu is outside the %zu-row frame", row, screen->rows);
		return -1;
	}
	if (bytes == NULL && length != 0) {
		set_error(error, error_capacity, "row %zu has a null byte pointer", row);
		return -1;
	}
	if (reserve_row(&screen->back[row], length) != 0) {
		set_error(error, error_capacity, "could not allocate %zu bytes for row %zu", length, row);
		return -1;
	}
	if (length != 0) {
		memcpy(screen->back[row].bytes, bytes, length);
	}
	screen->back[row].length = length;
	screen->staged[row] = 1;
	return 0;
}

int omp_tui_force_repaint(OmpTuiScreen *screen) {
	if (screen == NULL) {
		return -1;
	}
	screen->force_repaint = 1;
	return 0;
}

int omp_tui_flush(
	OmpTuiScreen *screen,
	const uint8_t *prologue,
	size_t prologue_length,
	const uint8_t *epilogue,
	size_t epilogue_length,
	OmpTuiSlice *out,
	char *error,
	size_t error_capacity
) {
	size_t index;
	size_t changed = 0;

	if (screen == NULL || out == NULL) {
		set_error(error, error_capacity, "screen or output slice pointer is null");
		return -1;
	}
	out->data = NULL;
	out->length = 0;
	screen->out_length = 0;
	screen->changed_rows = 0;

	for (index = 0; index < screen->rows; index += 1u) {
		if (screen->staged[index] == 0) {
			set_error(error, error_capacity, "row %zu was not staged for this frame", index);
			return -1;
		}
	}
	for (index = 0; index < screen->rows; index += 1u) {
		const OmpTuiRow *front = &screen->front[index];
		const OmpTuiRow *back = &screen->back[index];
		if (screen->force_repaint || front->length != back->length ||
			(back->length != 0 && memcmp(front->bytes, back->bytes, back->length) != 0)) {
			changed += 1u;
		}
	}
	if (changed == 0) {
		return 0;
	}

	if (append_output(screen, prologue, prologue_length) != 0) {
		set_error(error, error_capacity, "could not buffer the frame prologue");
		return -1;
	}
	for (index = 0; index < screen->rows; index += 1u) {
		const OmpTuiRow *front = &screen->front[index];
		const OmpTuiRow *back = &screen->back[index];
		if (!screen->force_repaint && front->length == back->length &&
			(back->length == 0 || memcmp(front->bytes, back->bytes, back->length) == 0)) {
			continue;
		}
		if (append_cursor_row(screen, index) != 0 || append_output(screen, back->bytes, back->length) != 0) {
			set_error(error, error_capacity, "could not buffer row %zu", index);
			return -1;
		}
	}
	if (append_output(screen, epilogue, epilogue_length) != 0) {
		set_error(error, error_capacity, "could not buffer the frame epilogue");
		return -1;
	}

	for (index = 0; index < screen->rows; index += 1u) {
		OmpTuiRow swapped = screen->front[index];
		screen->front[index] = screen->back[index];
		screen->back[index] = swapped;
	}
	screen->force_repaint = 0;
	screen->changed_rows = changed;
	out->data = screen->out;
	out->length = screen->out_length;
	return 0;
}

size_t omp_tui_rows(const OmpTuiScreen *screen) {
	return screen == NULL ? 0u : screen->rows;
}

size_t omp_tui_changed_rows(const OmpTuiScreen *screen) {
	return screen == NULL ? 0u : screen->changed_rows;
}
