---
layout: post
title:  "Interactive Rendering of the Moana Island Scene (Part 2)"
date:   2025-11-09
author: Maven Kim
---

This post will discuss how RTX Mega Geometry was used.

## Cluster Level Acceleration Structures
Acceleration structures (AS) are ubiquitously used in ray-tracing applications in order to 
reduce the number of ray-primitive intersection tests. There are multiple types of acceleration structures, such as kd-trees, grids, and bounding volume hierarchies (BVHs). The rest 
of this post will focus on BVHs since they are the standard data structure used in hardware ray tracing implementations. BVHs are a tree 
hierarchy of bounding volumes (boxes or spheres), where each bounding volume represents the total volume of a collection of primitives. In such a hierarchy, 
the root node represents the whole scene, and child nodes contain a subset of the primitives in the parent node. This structure reduces the complexity of ray tracing from O(N) 
to O(logN), and allows for quick rejection of an aggregate of primitives if their bounding volume is not intersected by a ray.

Graphics APIs, such as Vulkan and Direct 3D 12, provide function calls that can be used to build acceleration structures over a collection of triangles 
or AABBs, called a bottom level acceleration structure (BLAS). These BLASes can be used to build a top level acceleration structure (TLAS), which 
comtains instances of multiple BLASes.
Once TLASes are built, they can be accessed in GPU shaders, significantly speeding up ray tracing operations compared to CPU implementations. 
However, there are several issues with these ray tracing APIs. Acceleration structures can take up a significant amount of VRAM, 
which eats away at the limited memory budget on consumer GPUs (8-16 GB). These acceleration structures also can be slow to build on the GPU, especially when dealing 
with millions of primitives. While slow build times aren't as much of an issue for static geometry, they can have a significant impact on frame times in scenes with
dynamic geometry, such as skinned meshes. To combat these issues, developers have either had to reduce the number of primitives in these acceleration structures
by using simplified versions of scene geometry, or reduce the frequency of builds. For example, in Remedy Entertainment's Alan Wake 2, the frequency of AS updates
decreases based on the view distance of an object from the camera [\[Kandar et. al. 2024\]](https://www.nvidia.com/en-us/on-demand/session/gdc24-gdc1003/).
Both of these solutions lead to geometry in the AS no longer matching the directly visible geometry, leading to self-intersection artifacts.

To address these issues, NVIDIA recently released the RTX Mega Geometry API, which introduces new types of acceleration structures. 
Instead of building a traditional bottom level acceleration structure (BLAS) over triangles, BLASes
can now be built over cluster level acceleration structures ([CLAS](https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#cluster-geometry)). These CLASes can only be built over a few triangles and vertices (usually < 256). 
CLASes are well suited for hierarchical cluster level of detail (LOD) systems, such as Nanite. Instead of having to rebuild an entire mesh's BLAS when the LOD of 
only a few clusters changes, only the new clusters' CLAS have to be built. The BLAS build over clusters is also significantly faster, since there are ~100x less 
clusters than triangles.
There also now exists a cluster template acceleration structure, which takes an index buffer and precomputes information used in the AS that is independent 
of position. These templates can then be instantiated with vertex data, speeding up build times. This type of acceleration structure is well suited for both dynamic and tessellated geometry.

Although the primary benefit of this new API is reduced build times, it turns out that these new 
acceleration structures consume less memory compared to traditional triangle BLASes.
Below is a table showing a comparison in AS memory footprint between a traditional 
triangle BLAS and clustered acceleration structures. The CLAS total acceleration structure size includes all 
individual CLAS, as well as the cluster BLAS. The traditional triangle BLAS size is after compaction.

| Filename | Vertices | Triangles | CLAS Total Accel Size (in KB) | Triangle BLAS Total Size (in KB) |
|---|---|---|---|---|
| isMountainB/archives/xgBreadFruit_archiveBreadFruitBaked.obj | 3,070,229 | 4,216,610 | 49,226 | 105,706 |
| isIronwoodA1/isIronwoodA1.obj | 23,226,138 | 39,083,858 | 422,890 | 808,734 |
| isCoral/archives/xgFlutes_flutes.geo | 55 | 318 | 1.25 | 3.375 |
| isCoral/isCoral.obj | 1,877,141 | 2,894,788 | 33,077 | 75,408 |
| isPalmRig/isPalmRig2.obj | 84,422 | 132,320 | 1,537 | 3,235 |
| isBeach/isBeach.obj | 36,781 | 55,836 | 692 | 1,383 |
| isMountainA/isMountainA.obj | 43,890 | 67,006 | 924 | 1,776 |
| isDunesA/archives/xgHibiscusFlower_archiveHibiscusFlower0009_mod.obj | 2,428 | 3,888 | 44 | 98 |

Using CLAS saves roughly 50% of acceleration structure memory. For the Moana island scene, the total amount of AS memory saved is 1549 MB.

One caveat regarding these build sizes is that they are computed on the GPU, not the CPU. The Vulkan API provides a CPU function that returns an estimate 
of the memory required by a CLAS or cluster BLAS, named `vkGetClusterAccelerationStructureBuildSizesNV` ([spec](https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#vkGetClusterAccelerationStructureBuildSizesNV)).
This function returns a worst case memory amount, given the specified maximum number of triangles and vertices per cluster, or the maximum number of clusters per BLAS.
To get the memory needed per cluster or per BLAS, a descriptor struct ([clas](https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#VkClusterAccelerationStructureBuildTriangleClusterInfoNV) and [blas](https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#VkClusterAccelerationStructureBuildClustersBottomLevelInfoNV))
must be populated per cluster or per BLAS. The sizes are then returned in a specified `dstSizesArray` buffer, specified in a command info struct ([here](https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#VkClusterAccelerationStructureCommandsInfoNV)).
This means that in order to use the more granular allocation size, a readback to the CPU is necessary.

Another disadvantage of CLAS is that ray tracing performance is slightly worse. Remedy reports ~0.5 ms worse trace speed 
in Alan Wake 2 when using CLAS [[Marrs. et. al. 2025](https://www.nvidia.com/en-us/on-demand/session/gdc25-gdc1006/)].
Thus, they utilize traditional triangle BLAS for static geometry. 

## Partitioned Top Level Acceleration Structures (PTLAS)
Even with the memory compression provided by DGF and CLAS, there are still roughly 36 million instances to render. Multi-level instancing 
helps little, since ~23 million of these instances are singly instanced pebbles, flowers, and grains of sand on the beach. 
Building a TLAS over all of these instances would consume much more than the 8 GB of VRAM my GPU has.

To handle these instance counts, I utilize another new acceleration structure available through the Mega Geometry API: 
partitioned top level acceleration structures (PTLAS, spec [here](https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#partitioned-tlas)). Instead of 
building a TLAS over all instances, TLAS building is now separated into two steps. First, instances are assigned to a partition, and 
an acceleration structure is built over the instances in an individual partition. Second, the acceleration structure is built over all of the partitions. 
This setup allows for fast updates to the TLAS, since only the updated partitions have to be rebuilt per frame if the partition bounds don't change.
NVIDIA has released a vulkan sample that shows usage of this extension: [https://github.com/nvpro-samples/vk_partitioned_tlas](https://github.com/nvpro-samples/vk_partitioned_tlas).

To build a partitioned acceleration structure, the following Vulkan API function is used: 

```
// Provided by VK_NV_partitioned_acceleration_structure
void vkCmdBuildPartitionedAccelerationStructuresNV(
    VkCommandBuffer                             commandBuffer,
    const VkBuildPartitionedAccelerationStructureInfoNV* pBuildInfo);
```

Associated structs are listed below.

```
// Provided by VK_NV_partitioned_acceleration_structure
typedef struct VkBuildPartitionedAccelerationStructureInfoNV {
    VkStructureType                                       sType;
    void*                                                 pNext;
    VkPartitionedAccelerationStructureInstancesInputNV    input;
    VkDeviceAddress                                       srcAccelerationStructureData;
    VkDeviceAddress                                       dstAccelerationStructureData;
    VkDeviceAddress                                       scratchData;
    VkDeviceAddress                                       srcInfos;
    VkDeviceAddress                                       srcInfosCount;
} VkBuildPartitionedAccelerationStructureInfoNV;
```

```
// Provided by VK_NV_partitioned_acceleration_structure
typedef struct VkPartitionedAccelerationStructureInstancesInputNV {
    VkStructureType                         sType;
    void*                                   pNext;
    VkBuildAccelerationStructureFlagsKHR    flags;
    uint32_t                                instanceCount;
    uint32_t                                maxInstancePerPartitionCount;
    uint32_t                                partitionCount;
    uint32_t                                maxInstanceInGlobalPartitionCount;
} VkPartitionedAccelerationStructureInstancesInputNV;
```

The PTLAS requires a max instance count, a max instance per partition count, a max partition count, and a max instance in global partition count. 
For this application, a max instance count of 4,194,304 is used, and the PTLAS is ~900 MB.

To add an instance to a PTLAS, the following structure must be filled out: 

```
// Provided by VK_NV_partitioned_acceleration_structure
typedef struct VkPartitionedAccelerationStructureWriteInstanceDataNV {
    VkTransformMatrixKHR                                 transform;
    float                                                explicitAABB[6];
    uint32_t                                             instanceID;
    uint32_t                                             instanceMask;
    uint32_t                                             instanceContributionToHitGroupIndex;
    VkPartitionedAccelerationStructureInstanceFlagsNV    instanceFlags;
    uint32_t                                             instanceIndex;
    uint32_t                                             partitionIndex;
    VkDeviceAddress                                      accelerationStructure;
} VkPartitionedAccelerationStructureWriteInstanceDataNV;
```

The noteable entries are the `instanceIndex` and `partitionIndex`. The `instanceIndex` is a unique identifier that must be less than the previously specified `instanceCount`
value. If a previous PTLAS build operation had an instance with this same `instanceIndex`, it is replaced with the newly specified instance. If there are two or more descriptors in the same 
build call with the same `instanceIndex`, an error will occur. The `partitionIndex` member specifies which partition the instance is a part of. If more than `maxInstancePerPartitionCount`
instances are allocated with the same `partitionIndex`, an error will occur. An error will also occur if `partitionIndex` is greater than `partitionCount`.

I use this extension to disable groups of instances that are subpixel from the current camera view. Before rendering starts, instances that are below a certain threshold in size/triangle count 
are separated into partitions of <1024 instances. A binned sweep SAH partition scheme is used [[Wald 2007](https://www.sci.utah.edu/~wald/Publications/2007/ParallelBVHBuild/fastbuild.pdf)]. Once these partitions are created, the sphere bounds of the partition is calculated, and all partition information is 
sent to the GPU. Every frame, the GPU checks each partition to see whether it is large enough on the screen, and depending on the result, the instances are added or removed from the PTLAS.
The `instanceIndex` value is allocated from a GPU free list, which contains all of the unused instance indices. Partitions that are too small add all of their instances' allocated indices
to this list, and partitions that are large allocate from the free list. Freed instances are also disabled by filling out a `VkPartitionedAccelerationStructureWriteInstanceDataNV`
descriptor with the corresponding `instanceIndex` and a value of 0 for the `accelerationStructure` field.

One important thing to note is that even if instances are disabled, they still count towards the `maxInstancePerPartitionCount` value. Thus, if a partition is freed and then reallocated later,
stale indices from that same partition could still remain on the free list, causing the partition to exceed the `maxInstancePerPartitionCount` limit. Care must be taken to 
reuse these stale indices to prevent this error from happening.

## Links
Kandar et. al. 2024, "Alan Wake 2: A Deep Dive into Path Tracing Technology" [https://www.nvidia.com/en-us/on-demand/session/gdc24-gdc1003/](https://www.nvidia.com/en-us/on-demand/session/gdc24-gdc1003/)
Marrs. et. al. 2025, "Scale Up Ray Tracing in Games with RTX Mega Geometry" [https://www.nvidia.com/en-us/on-demand/session/gdc25-gdc1006/](https://www.nvidia.com/en-us/on-demand/session/gdc25-gdc1006/)
NVIDIA 2025, "vk_partitioned_tlas" [https://github.com/nvpro-samples/vk_partitioned_tlas](https://github.com/nvpro-samples/vk_partitioned_tlas)
Vulkan 2025, "Cluster Level Acceleraton Structures" [https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#cluster-geometry](https://docs.vulkan.org/spec/latest/chapters/accelstructures.html#cluster-geometry)
Wald 2007, [https://www.sci.utah.edu/~wald/Publications/2007/ParallelBVHBuild/fastbuild.pdf](https://www.sci.utah.edu/~wald/Publications/2007/ParallelBVHBuild/fastbuild.pdf)
