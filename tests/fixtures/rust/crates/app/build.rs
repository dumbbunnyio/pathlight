mod gen;

use gen::make;

fn main() {
    cc::Build::new();
    make();
}
