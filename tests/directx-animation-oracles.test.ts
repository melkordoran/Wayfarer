import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  directXMatrixReferenceText, directXQuaternionReferenceText, directXReferenceOracle as oracle,
} from './fixtures/directx-animation-oracles';

function close(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 12));
}

describe('independent original DirectX animation mathematical oracles', () => {
  it('pairs source WXYZ quaternion records with independently handwritten row matrices', () => {
    for (let i = 0; i < oracle.rotationKeys.length; i++) {
      const [w, x, y, z] = oracle.rotationKeys[i].values;
      const encodedRotation = new Quaternion(-x, -y, -z, w);
      const p = new Vector3(), q = new Quaternion(), scale = new Vector3();
      const matrix = new Matrix4().fromArray(oracle.matrixKeys[i].values);
      matrix.decompose(p, q, scale);
      expect(Math.abs(q.dot(encodedRotation))).toBeCloseTo(1, 12);
      close(p.toArray(), oracle.translationKeys[i].values);
      close(scale.toArray(), [1, 1, 1]);
    }
  });

  it('distinguishes noncommuting reference multiplication order with a physical point oracle', () => {
    const reference = new Quaternion().fromArray(oracle.firstThreeQuaternion);
    const end = new Quaternion().fromArray(oracle.lastThreeQuaternion);
    const relative = reference.clone().invert().multiply(end);
    const wrong = end.clone().multiply(reference.clone().invert());
    close(relative.toArray(), oracle.relativeThreeQuaternion);
    close(wrong.toArray(), oracle.reversedOrderThreeQuaternion);
    close(new Vector3().fromArray(oracle.testPoint).applyQuaternion(reference.clone().multiply(relative)).toArray(), oracle.expectedLastRotatedPoint);
    close(new Vector3().fromArray(oracle.testPoint).applyQuaternion(reference.clone().multiply(wrong)).toArray(), oracle.wrongOrderRotatedPoint);
  });

  it('preserves the geometry bind position while removing the first animation translation', () => {
    const delta = new Vector3().fromArray(oracle.translationKeys[1].values)
      .sub(new Vector3().fromArray(oracle.translationKeys[0].values));
    close(delta.toArray(), oracle.translationDelta);
    const final = new Vector3().fromArray(oracle.testPoint)
      .applyQuaternion(new Quaternion().fromArray(oracle.lastThreeQuaternion))
      .add(new Vector3().fromArray(oracle.geometryBindPosition)).add(delta);
    close(final.toArray(), oracle.expectedLastRetargetedPoint);
  });

  it('uses source-row SRT order without an additional transpose', () => {
    // Row-vector scale(2,3,4), Rx90, translate(3,5,7), in that order.
    const matrix = new Matrix4().fromArray([2, 0, 0, 0, 0, 0, 3, 0, 0, -4, 0, 0, 3, 5, 7, 1]);
    close(new Vector3(1, 2, 3).applyMatrix4(matrix).toArray(), [5, -7, 13]);
    const p = new Vector3(), q = new Quaternion(), scale = new Vector3();
    matrix.decompose(p, q, scale);
    close(p.toArray(), [3, 5, 7]);
    close(scale.toArray(), [2, 3, 4]);
    expect(Math.abs(q.dot(new Quaternion().fromArray(oracle.firstThreeQuaternion)))).toBeCloseTo(1, 12);
    close(new Matrix4().compose(p, q, scale).toArray(), matrix.toArray());
  });

  it('emits independent, short-line CRLF text fixtures with no borrowed content', () => {
    const fixtures = [directXQuaternionReferenceText, directXMatrixReferenceText(3), directXMatrixReferenceText(4)];
    for (const source of fixtures) {
      expect(source.startsWith('xof 0303txt 0032\r\n')).toBe(true);
      expect(source.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
      expect(Math.max(...source.split('\r\n').map(line => line.length))).toBeLessThan(250);
      expect(source.match(/AnimationSet /g)).toHaveLength(1);
      expect(source).toContain('{ aw_elbow_l }');
    }
  });
});
