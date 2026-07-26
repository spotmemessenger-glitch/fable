package com.fibonacci;

import java.util.stream.Stream;

/**
 * Generates and prints Fibonacci numbers.
 */
public final class FibonacciApplication {

    private static final int LIMIT = 15;

    private record FibonacciPair(long current, long next) {
        public FibonacciPair nextPair() {
            return new FibonacciPair(next, Math.addExact(current, next));
        }
    }

    public static void main(final String[] args) {
        Stream.iterate(new FibonacciPair(0, 1), FibonacciPair::nextPair)
                .map(FibonacciPair::current)
                .limit(LIMIT)
                .forEach(System.out::println);
    }
}
