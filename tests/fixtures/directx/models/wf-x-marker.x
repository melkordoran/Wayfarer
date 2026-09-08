xof 0303txt 0032
// Original Wayfarer fixture. CC0. RH, +Y up, authored source units.
Frame MarkerParent {
 FrameTransformMatrix {
  0,0,-1,0,0,1,0,0,1,0,0,0,3,0,-2,1;;
 }
 Frame MarkerChild {
  FrameTransformMatrix {
   1,0,0,0,0,1,0,0,0,0,1,0,1,0.5,2,1;;
  }
  Mesh OriginalConcaveMarker {
   9;
   0;0;0;,
   2;0;0;,
   2;0.5;0;,
   1;0.5;0;,
   1;1.5;0;,
   0;1.5;0;,
   0;0;-0.25;,
   1;0;-0.25;,
   0;0;0.75;;
   2;
   6;0,1,2,3,4,5;,
   3;6,8,7;;
   MeshNormals {
    2;
    0;0;1;,
    0;1;0;;
    2;
    6;0,0,0,0,0,0;,
    3;1,1,1;;
   }
   MeshTextureCoords {
    9;
    0;1;,
    1;1;,
    1;0.666666667;,
    0.5;0.666666667;,
    0.5;0;,
    0;0;,
    0;0;,
    1;0;,
    0;1;;
   }
   MeshMaterialList {
    2;
    2;
    0,1;;
    Material OriginalTeal {
     1;1;1;1;;
     8;
     .1;.1;.1;;
     0;0;0;;
     TextureFilename {
      "wf-x-corners.png";
     }
    }
    Material OriginalGold {
     0.92;0.58;0.18;0.65;;
     8;
     .1;.1;.1;;
     0;0;0;;
    }
   }
  }
 }
}
