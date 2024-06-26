# NNEDI3js

This is an implementation of the tritical's NNEDI3 algorithm in Javascript. NNEDI3 is a neural network based scaling algorithm that can produce high quality power of two image resizes. You can find tritical's original AviSynth based implementation [here](http://web.archive.org/web/20121019082153/http://bengal.missouri.edu/~kes25c/).

The port was done by hand and not using something like Emscripten. At the moment this is only useful as a slow, high quality image resizer.

Do note that it may take a while to perform the first resize since it needs to download a 13MB binary file of weights before the scaling can begin.

### User Configurable Settings

- Total Scale: This is how much larger you want the image. NNEDI3 can only scale by powers of two.
- Number of Neurons: This controls the number of neurons in the neural network. Increasing the number of neurons increases the final quality of the image, but also makes the scaling take longer.
- Local Neighbourhood: This is the area around each pixel that is sampled by the algorithm. 8x6 and 8x4 are the best options for image resizing. The other four options are better for deinterlacing (which isn't supported by this implementation yet) and can give strange results when scaling non-interlaced material.
- Prescreener: The prescreener determines pixels that do not need to be scaled by the neural network and scales them using a faster, simpler algorithm. With it on images should be scaled far quicker with only a small difference in quality.
- Sets of Weights Used: This runs the input through a second neural network after the first one. Setting this to "2" produces a slightly higher quality output. However, increasing number of neurons by one step is usually a better choice for about the same performance hit.

### Known Bugs

This generates different mirroring artifacts than the AviSynth versions of NNEDI3. I am guessing this is due to differences in how the image is rotated, but I haven't looked too far into it.

### TODO (Maybe)

- Use WebGL to do the scaling instead of performing it on the CPU. 
  - There is a good implementation of NNEDI3 in OpenGL that was created for MPV. It would likely not be too hard to get it working in WebGL 2.
- Correct for the center shift introduced by the NNEDI3 algorithm.
- Offer an option to upload a video and see it scaled on-the-fly.
