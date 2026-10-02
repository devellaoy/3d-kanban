/** The mouse-look a window gave back while a trip had the controls, held for the arrival (see backToGame in input/focus.ts and controlsBack in core/travel.ts). */
export function relookOnArrival() {
  let held = false;
  return {
    /** Takes the mouse back now (`lock`), or, on the way to another floor, once you're there. */
    takeBack(onTrip: boolean, lock: () => void) {
      if (onTrip) held = true;
      else lock();
    },
    /** There, or the trip failed: takes the mouse back (`back`) if it was held and the controls are yours (`enabled`: no window up). Either way nothing is held after. */
    arrived(enabled: boolean, back: () => void) {
      const was = held;
      held = false;
      if (was && enabled) back();
    },
    /** Nothing to take back (no floor to arrive on). */
    drop() {
      held = false;
    },
    get held() {
      return held;
    },
  };
}
