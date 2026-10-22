// Reads that run before their binding is initialized throw Node's
// ReferenceError: a class read through object-literal shorthand from a
// function called before the class statement, and the left operand of a
// statically decided instanceof whose constructor operand is computed.
class Plain {}
const lib = { Plain };

function early(): { Late: typeof Late } {
  return { Late };
}
function earlyInstance(): boolean {
  return pending instanceof lib.Plain;
}

function attempt(label: string, run: () => unknown): void {
  try {
    run();
    console.log(label, "returned");
  } catch (error) {
    console.log(label, (error as Error).name, (error as Error).message);
  }
}
attempt("shorthand", early);
attempt("instanceof", earlyInstance);

class Late {
  static tag = "late";
}
let pending = new Plain();
const late = early().Late;
console.log(late.tag, late === Late, earlyInstance());
