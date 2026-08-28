/*
 * chudcode-seat-shim: the minimum EWMH surface chudcode's X11 desktop backend needs.
 *
 * chudcode enumerates windows purely from root properties
 * (crates/chud-natives/src/desktop/linux/x11/capture.rs:190) and activates windows
 * by sending a _NET_ACTIVE_WINDOW client message to the root
 * (crates/chud-natives/src/desktop/linux/x11/input.rs:372).  A bare Xvfb has no
 * window manager, so those properties never exist and desktop.windows() returns
 * an empty list.  This publishes them and honours activation, without taking
 * over geometry (no SubstructureRedirect): apps keep placing themselves, which
 * is what an agent seat wants.
 *
 * Build: gcc -O2 -o chudcode-seat-shim ewmh-shim.c -lX11
 * Run:   DISPLAY=:90 ./chudcode-seat-shim
 *
 * A real WM (openbox, i3) works equally well; this exists so the seat needs no
 * package install and no theming/compositing overhead.
 */
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_CLIENTS 256

static Display *dpy;
static Window root;
static Window wm_check;
static Atom a_client_list, a_client_list_stacking, a_active_window, a_supported,
    a_supporting_wm_check, a_wm_name, a_utf8;


/*
 * Windows die between XQueryTree and the per-window round trips; those raced
 * requests must not be fatal.
 */
static int ignore_x_error(Display *display, XErrorEvent *error) {
	(void)display;
	if (error->error_code == BadWindow || error->error_code == BadDrawable ||
	    error->error_code == BadMatch)
		return 0;
	fprintf(stderr, "chudcode-seat-shim: X error %d (request %d)\n", error->error_code,
	        error->request_code);
	return 0;
}

static int is_toplevel(Window w) {
	XWindowAttributes attrs;
	if (!XGetWindowAttributes(dpy, w, &attrs)) return 0;
	if (attrs.override_redirect) return 0;
	if (attrs.map_state != IsViewable) return 0;
	if (attrs.width < 16 || attrs.height < 16) return 0;
	return 1;
}

/* Publishes bottom-to-top stacking order, as EWMH specifies. */
static void publish(void) {
	Window r, parent, *children = NULL;
	unsigned int count = 0;
	if (!XQueryTree(dpy, root, &r, &parent, &children, &count)) return;

	Window clients[MAX_CLIENTS];
	int n = 0;
	for (unsigned int i = 0; i < count && n < MAX_CLIENTS; i++) {
		if (children[i] == wm_check) continue;
		if (is_toplevel(children[i])) clients[n++] = children[i];
	}
	if (children) XFree(children);

	XChangeProperty(dpy, root, a_client_list, XA_WINDOW, 32, PropModeReplace,
	                (unsigned char *)clients, n);
	XChangeProperty(dpy, root, a_client_list_stacking, XA_WINDOW, 32, PropModeReplace,
	                (unsigned char *)clients, n);

	/* Keep _NET_ACTIVE_WINDOW pointing at a live client: chudcode reads it for
	 * `focused` and restores it after foreground delivery. */
	Window active = None;
	unsigned char *value = NULL;
	Atom type;
	int format;
	unsigned long items, after;
	if (XGetWindowProperty(dpy, root, a_active_window, 0, 1, False, XA_WINDOW, &type,
	                       &format, &items, &after, &value) == Success) {
		if (value && items == 1) active = *(Window *)value;
		if (value) XFree(value);
	}
	int still_live = 0;
	for (int i = 0; i < n; i++)
		if (clients[i] == active) still_live = 1;
	if (!still_live) {
		active = n > 0 ? clients[n - 1] : None;
		if (active != None) {
			XSetInputFocus(dpy, active, RevertToPointerRoot, CurrentTime);
			XChangeProperty(dpy, root, a_active_window, XA_WINDOW, 32, PropModeReplace,
			                (unsigned char *)&active, 1);
		}
	}
	XFlush(dpy);
}

static void activate(Window w) {
	if (!is_toplevel(w)) return;
	XRaiseWindow(dpy, w);
	XSetInputFocus(dpy, w, RevertToPointerRoot, CurrentTime);
	XChangeProperty(dpy, root, a_active_window, XA_WINDOW, 32, PropModeReplace,
	                (unsigned char *)&w, 1);
	XFlush(dpy);
}

int main(void) {
	dpy = XOpenDisplay(NULL);
	if (!dpy) {
		fprintf(stderr, "chudcode-seat-shim: cannot open DISPLAY=%s\n",
		        getenv("DISPLAY") ? getenv("DISPLAY") : "(unset)");
		return 1;
	}
	XSetErrorHandler(ignore_x_error);
	root = DefaultRootWindow(dpy);

	a_client_list = XInternAtom(dpy, "_NET_CLIENT_LIST", False);
	a_client_list_stacking = XInternAtom(dpy, "_NET_CLIENT_LIST_STACKING", False);
	a_active_window = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
	a_supported = XInternAtom(dpy, "_NET_SUPPORTED", False);
	a_supporting_wm_check = XInternAtom(dpy, "_NET_SUPPORTING_WM_CHECK", False);
	a_wm_name = XInternAtom(dpy, "_NET_WM_NAME", False);
	a_utf8 = XInternAtom(dpy, "UTF8_STRING", False);

	wm_check = XCreateSimpleWindow(dpy, root, -10, -10, 1, 1, 0, 0, 0);
	XChangeProperty(dpy, wm_check, a_wm_name, a_utf8, 8, PropModeReplace,
	                (unsigned char *)"chudcode-seat-shim", 13);
	XChangeProperty(dpy, wm_check, a_supporting_wm_check, XA_WINDOW, 32, PropModeReplace,
	                (unsigned char *)&wm_check, 1);
	XChangeProperty(dpy, root, a_supporting_wm_check, XA_WINDOW, 32, PropModeReplace,
	                (unsigned char *)&wm_check, 1);
	Atom supported[] = {a_client_list, a_client_list_stacking, a_active_window,
	                    a_supporting_wm_check};
	XChangeProperty(dpy, root, a_supported, XA_ATOM, 32, PropModeReplace,
	                (unsigned char *)supported, 4);

	/* Notify only: apps stay in charge of their own geometry. */
	XSelectInput(dpy, root, SubstructureNotifyMask | PropertyChangeMask);
	publish();
	printf("chudcode-seat-shim: publishing EWMH on %s\n", XDisplayString(dpy));
	fflush(stdout);

	for (;;) {
		XEvent event;
		XNextEvent(dpy, &event);
		switch (event.type) {
			case MapNotify:
			case UnmapNotify:
			case DestroyNotify:
			case ConfigureNotify:
			case ReparentNotify:
				publish();
				break;
			case ClientMessage:
				if (event.xclient.message_type == a_active_window)
					activate(event.xclient.window);
				break;
			default:
				break;
		}
	}
}
