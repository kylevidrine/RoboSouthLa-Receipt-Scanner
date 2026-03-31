/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Receipt {
  id: string;
  uid: string;
  image: string;
  timestamp: number;
  name: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Quad {
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
}
