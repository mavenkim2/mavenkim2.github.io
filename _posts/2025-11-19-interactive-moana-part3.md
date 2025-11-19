---
layout: post
title:  "Interactive Rendering of the Moana Island Scene (Part 3)"
date:   2025-11-19
author: Maven Kim
---

## Texture Streaming
The Moana island data set uses [Ptex](https://ptex.us/), which stores textures per face instead of per-mesh. This parameterization removes the need for per vertex uv's, and removes the need for artists 
to painstakingly create UV maps. However, it also means that a custom filtering and streaming system will be needed. The total texture footprint is 28 GB, which exceeds the memory capacity of my GPU, 
so a fast, Ptex-native streaming system is necessary for interactive rendering.

Luckily, Disney recently gave a talk at SIGGRAPH about this exact problem [[Lee et. al. 2025](https://www.yiningkarlli.com/projects/gpuptex.html)]. My system closely follows this paper, 
with some modifications since I'm using Vulkan instead of CUDA.

Every frame, the renderer writes the ptex face ID, texture ID, and mip level requested by all camera primary ray hits, and stores them to a feedback buffer. 
This feedback buffer is copied from device to host memory, and then copied to a ring buffer. On separate threads, feedback requests are read from this ring buffer, duplicate requests are pruned,
and unmapped requests are loaded from disk. The loaded textures are allocated using a GPU slab allocator with 512 KB chunks. These chunks can only allocate textures with fixed dimensions, 
such as 128x128 or 32x64. All textures are rotated so that their width is greater than their height, which reduces the number of unique slabs. A `Texture2DArray` is used for each slab, 
which allows the worker threads to asynchronously transition image layouts and synchronize each individual array layer. Every layer of every texture array is individually accessible on the GPU 
using bindless descriptors, significantly simplifying descriptor management. At runtime, a hash table is used to map the face ID, texture ID, and mip level to this bindless descriptor, 
allowing the entire texture cache to be easily accessed. If there is no hash table entry, a 1x1 fallback is used.

One issue with the above system is that texture memory is usually aligned to a power of two value, such as 512 or 1024 bytes. This alignment applies to each indiviudal layer of a texture array, 
not to the whole array, which means that slabs with 1x1 or 2x2 textures would waste a significant amount of memory just on alignment. Thus, the minimum width and height of a texture array 
is limited to 16, and textures with dimensions smaller than this are packed into mini 16x16 atlases within a particular array layer. Since these small textures no longer occupy an 
independent layer of a texture, they must be synchronously uploaded to the GPU. 

For primary ray hits, it's possible that many threads in the same warp will intersect the same face. To reduce the number of duplicate requests, I've implemented a fast 
per-wave compaction scheme using WaveMatch (see [here](https://microsoft.github.io/DirectX-Specs/d3d/HLSL_ShaderModel6_5.html#wavematch-function)). This intrinsic 
returns a bitmask that represents the set of lanes with a value matching the one in the current lane. When multiple threads in a wave have an identical feedback request, 
only the thread with the highest index will write the request to the feedback buffer, which prunes duplicate requests.

```
uint2 feedbackRequest = uint2(textureIndex | (tileIndex << 16u), faceID | (mipLevel << 28u));
uint4 mask = WaveMatch(feedbackRequest.x);
int4 highLanes = (int4)(firstbithigh(mask) | uint4(0, 0x20, 0x40, 0x60));
uint highLane = (uint)max(max(highLanes.x, highLanes.y), max(highLanes.z, highLanes.w));
bool isHighLane = all(feedbackRequest != ~0u) && WaveGetLaneIndex() == highLane;

// only the highest index thread for each identical set increments the atomic counter
uint index;
WaveInterlockedAddScalarTest(feedbackBuffer[0], isHighLane, 2, index);
if (isHighLane)
{
    // write request
    feedbackBuffer[index + 1] = feedbackRequest.x;
    feedbackBuffer[index + 2] = feedbackRequest.y;
}
```

Texture filtering is the same as in the above talk. To give a brief overview, instead of taking multiple taps per texture request, applying weights to each tap, 
and then summing up the contributions (traditional filtering), the weights of the filter are used as a PDF that is sampled once with nearest-neighbor. This removes the need 
for texture borders, which are commonly required in texture streaming system. For more details, see the above talk and this [paper](https://dl.acm.org/doi/10.1145/3651293).

## Hierarchical LOD
Originally, I attempted to implement a hierarchical LOD streaming system, heavily inspired by the recent [Zorah](https://www.nvidia.com/en-us/on-demand/session/gdc25-gdc1002/) demo from NVIDIA. 
I ended up removing this system and simply storing all of the BLASes in GPU memory, with no streaming. 

One issue with the LOD system was due to a commonly known problem with quadric error mesh simplification (QEM), which is used when generating cluster LODs. QEM struggles when geometry contains a large number of unconnected islands, 
which is very common in foliage. Below are some images demonstrating the problem.

![madrona0](/assets/images/tree_madrona_0.png)
Figure 1. Render of xgFoliageB_treeMadronaBaked_canopyOnly_lo.obj at lod level 0.

![madrona3](/assets/images/tree_madrona_3.png)
Figure 2. Render of xgFoliageB_treeMadronaBaked_canopyOnly_lo.obj at lod level 2. Notice how visually, there appears to be less leaves.

Recent work from Epic Games addresses this issue with Nanite Voxels, first introduced in the Witcher 4 [demo](https://www.youtube.com/watch?v=Nthv4xF_zHU). Instead of simplifying clusters with QEM, 
clusters are first voxelized, with a voxel size matching the error returned by the quadric error process. If the number of voxels returned from the voxelization process is above some threshold, 
the process is repeated with a larger voxel size until the threshold is met. If the final voxel size is still less than the QEM error metric, then then voxelized version 
of the cluster is used for all future simplification steps. The voxelization process follows the method outlined in *Hybrid mesh-volume LoDs for all-scale pre-filtering of complex 3D assets*
[[Loubet and Neyret, 2017](https://hal.science/hal-01468817)]. First, voxels are generated from a cluster using traditional methods. Afterwards, for each voxel, a ray is randomly generated within a small disk 
centered at the center of the voxel. The ray is bounded such that its `tMax` is at the voxel's boundary, and then traced against the original, unsimplified mesh. If the ray intersects geometry, 
the normal of the intersected geometry is added to an [SGGX](https://dl.acm.org/doi/10.1145/2766988) normal distribution. The code for the offline voxelization process is at `Engine/Source/Developer/NaniteBuilder/Private/Cluster.cpp`.

This system was designed for rasterization, so I attempted to implement a version of it that would work with ray-tracing. Below is an image of a voxelized foliage element.

![madrona voxel](/assets/images/tree_madrona_voxel.png)
Figure 3. Voxelized render of xgFoliageB_treeMadronaBaked_canopyOnly_lo.obj

In the end, I couldn't get the appearance of the voxels to quite match the original geometry. I originally tried to implement this system because I thought it would be necessary, but I 
realized after I implemented it that the base unique geometry could fit in GPU memory with no streaming. Also, it was unclear how to handle the texture parameterization of the simplified clusters (both triangles and voxels). 
The QEM simplification process assumes that the input mesh has a single texture parameterization, which conflicts with the Ptex representation. Converting from Ptex to traditional uv's would've been a pretty 
significant undertaking that I'm glad I did not have to do.

## Limitations
Outside of the obvious lack of curves, the culling of sub pixel instances mentioned in the previous post is currently not strict enough at certain camera viewpoints. This means that some instances 
are not rendered when they should be. For the texture streaming system, there are magnification artifacts at close view distances, which is a known limitation with the above filtering method.
Research regarding solutions for this problem have been published, but have not been implemented.

## Conclusion
Thanks for reading this far! If you have any questions regarding anything, feel free to send an email.

## Links
Pharr et. al 2024, "Filtering After Shading With Stochastic Texture Filtering" [https://dl.acm.org/doi/10.1145/3651293](https://dl.acm.org/doi/10.1145/3651293)

Lee et. al 2025, "A Texture Streaming Pipeline for Real-Time GPU Tracing" [https://www.yiningkarlli.com/projects/gpuptex.html](https://www.yiningkarlli.com/projects/gpuptex.html)

Loubet and Neyret 2017, "Hybrid mesh-volume LoDs for all-scale pre-filtering of complex 3D assets" [https://hal.science/hal-01468817](https://hal.science/hal-01468817)

Ptex [https://ptex.us/](https://ptex.us/)

The SGGX microflake dstribution [https://dl.acm.org/doi/10.1145/2766988](https://dl.acm.org/doi/10.1145/2766988)

WaveMatch [https://microsoft.github.io/DirectX-Specs/d3d/HLSL_ShaderModel6_5.html#wavematch-function](https://microsoft.github.io/DirectX-Specs/d3d/HLSL_ShaderModel6_5.html#wavematch-function)

Witcher 4 Demo [https://www.youtube.com/watch?v=Nthv4xF_zHU](https://www.youtube.com/watch?v=Nthv4xF_zHU)

Zorah [https://www.nvidia.com/en-us/on-demand/session/gdc25-gdc1002/](https://www.nvidia.com/en-us/on-demand/session/gdc25-gdc1002/)
