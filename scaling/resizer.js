//"use strict";
var gl = null;
var texture_ = null;
var texture_fbo = null;
var fbo_ = null;
var progRotate = null;
var vert_buf = null;

var native_width = null;
var native_height = null;
var native_Img = null;

// These should probably be consts instead...
var NO_ROTATE = 0;
var ROTATE_RIGHT = 1;
var ROTATE_LEFT = 2;
var MIN_PAD = 10;
var MIN_ALIGNMENT = 16;

//Neural Network size (number of neurons)
//0 = 16, 1 = 32, 2 = 64, 3 = 128, 4 = 256
var NNS_TABLE = new Int32Array([16, 32, 64, 128, 256]);
var NUM_NNS = 5;
var g_nns = 0;

//Size of the local neighbourhood around each pixel 
//0 = 8x6, 1 = 16x6, 2 = 32x6, 3 = 48x6, 4 = 8x4, 5 = 16x4, 6 = 32x4
var XDIA_TABLE = new Int32Array([8, 16, 32, 48, 8, 16, 32]);
var YDIA_TABLE = new Int32Array([6, 6, 6, 6, 4, 4, 4]);
var NUM_NSIZE = 7;
var g_nsize = 0

//Quality level (1 or 2)
//Determines the number of different neural network predictions that are blended together.
var g_qual = 1;

//Error type
//0 - weights trained to minimize absolute error
//1 - weights trained to minimize squared error
var g_etype = 0;

//Controls what prescreener is used
//The prescreener is trained to know whether cubic interpolation will be sufficient 
//for a pixel or whether it should be predicted by the predictor nn.
//0 - no prescreening
//1 - original prescreener (About the same as option 2 but much slower)
//2 - new prescreener level 0 (Does the most cubic interpolation of the new versions)
//3 - new prescreener level 1
//4 - new prescreener level 2 (Does the least cubic interpolation of the new versions)
//When NNEDI3 is CPU-based disabling the prescreener slows it down by an exponential factor
//When it is GPU-based the slowdown should be far less, but it is still limited due to the
//the GPU not having an infinite number of pipelines.
//The artifacts produced by the prescreener are not usually very noticeable
var g_pscrn = 2;

//Image enlargement factor (must be exactly 1 or a power of 2)
var g_rfactor = 1;

//Sets the resizer used for correcting the image center shift that nnedi3_rpow2 introduces.
//Could be lanczos, spline36, etc. Not sure exactly how to do this in opengl at a subpixel 
//level the same way Avisynth is able to.
var g_cshift = "lanczos6tap";

//The final width and final height that are achieved using the cshift specified resizer.
//If this is the same as the power of 2 resize nnedi achieves then these are ignored.
var g_fwidth = 1920;
var g_fheight = 1080;

//the binary containing the various weights
var g_bdata = null;

//----------------------------------------------------------------------

function change_canvas_scale(scale) {
   var canvas = document.getElementById("test_canvas");
   canvas.width = texture_.image.width * scale;
   canvas.height = texture_.image.height * scale;
}

function set_resize(scale) {
   var output = document.getElementById("total_scale_output");
   output.innerHTML = scale + "x";
   g_rfactor = scale;
}

function set_nns(index) {
   g_nns = index;
   var output = document.getElementById("nns_output");
   output.innerHTML = NNS_TABLE[g_nns];
}

function set_pscrn(index) {
	g_pscrn = index;
	var output = document.getElementById("pscrn_output");
	if (g_pscrn === 0) {
		output.innerHTML = "Off";
	} else {
		output.innerHTML = "On";
	}
}

function set_nsize(index) {
	g_nsize = index;
	var output = document.getElementById("nsize_output");
	output.innerHTML = XDIA_TABLE[g_nsize]+"x"+YDIA_TABLE[g_nsize];
}

function set_qual(index) {
	g_qual = index;
	var output = document.getElementById("qual_output");
	if (g_qual === 1) {
		output.innerHTML = "1";
	} else {
		output.innerHTML = "2";
	}
}

function save_image() {
	var win= window.open();
	win.document.write('<img src="'+document.getElementById("test_canvas").toDataURL()+'"/>');
	win.document.close();
}

//This function is unreachable code
function set_filter(smooth) {
   if (smooth) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
   } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
   }
}

//This function is unreachable code
function do_filter(smooth) {
	gl.bindTexture(gl.TEXTURE_2D, texture_);
	set_filter(smooth);
	gl.bindTexture(gl.TEXTURE_2D, null);
	var output = document.getElementById("filter_output");
	if (smooth) {
		output.innerHTML = "Linear";
	} else {
		output.innerHTML = "Point";
	}
	do_render(NO_ROTATE);
}

//1st function in webGLStart()
function initGL(canvas) {
   try {
      gl = canvas.getContext("webgl", {preserveDrawingBuffer: true});
      if (gl == null) {
         gl = canvas.getContext("experimental-webgl", {preserveDrawingBuffer: true});
      }
      gl.viewportWidth = canvas.width;
      gl.viewportHeight = canvas.height;
   } catch (e) {}
   if (gl == null) {
      alert("Could not init WebGL ... :(");
   }
}

function getShader(id) {
   var script = document.getElementById(id);
   if (!script) { return null; }

   var str = "";
   var k = script.firstChild;
   while (k) {
      if (k.nodeType == 3) { //A Text_Node
         str += k.textContent;
      }
      k = k.nextSibling;
   }

   var shader;
   if (script.type == "x-shader/x-fragment") {
      shader = gl.createShader(gl.FRAGMENT_SHADER);
   } else if (script.type == "x-shader/x-vertex") {
      shader = gl.createShader(gl.VERTEX_SHADER);
   } else {
      return null;
   }

   gl.shaderSource(shader, str);
   gl.compileShader(shader);

   if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      alert(gl.getShaderInfoLog(shader));
      return null;
   }

   return shader;
}

function set_image(img) {
	gl.bindTexture(gl.TEXTURE_2D, texture_);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

	// Would prefer clamp to border,
	// but GLES only supports CLAMP_TO_EDGE with NPOT textures.
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function load_image(evt) {
   if (!(window.File && window.FileReader && window.FileList && window.Blob)) {
      alert("FileReader API not supported by this browser ...");
      return;
   }

   var file = evt.target.files[0];
   if (!file.type.match("image.*")) {
      alert("This is not an image file! :(");
      return;
   }

   var reader = new FileReader();
   reader.onload = 
      function(e) {
         texture_.old_img = texture_.image;
         texture_.image = new Image();
         texture_.image.onload = function() {
            if (texture_.image.width > 0 && texture_.image.height > 0) {
               try {
				  native_width = texture_.image.width;
				  native_height = texture_.image.height;
				  native_Img = texture_.image;
                  set_image(texture_.image);
				  change_canvas_scale(1) 
               } catch (e) {
                  texture_.image = texture_.old_img;
                  alert(e);
               }
            } else {
               texture_.image = texture_.old_img;
            }

			do_render(NO_ROTATE);
         }
         texture_.image.src = e.target.result;
      }

   reader.onerror =
      function(err) {
         alert("FileReader error: " + err.getMessage());
      }

   reader.readAsDataURL(file);
}

function parse_xml(text) {
   try {
      var vert = null;
      var frag = null;

      var parser = new DOMParser();
      var xmldoc = parser.parseFromString(text, "text/xml");

      var elems;
      elems = xmldoc.getElementsByTagName("vertex");
      if (elems.length > 0) {
         vert = elems[0].childNodes[0].nodeValue;
      }
      elems = xmldoc.getElementsByTagName("fragment");
      if (elems.length > 0) {
         frag = elems[0].childNodes[0].nodeValue;
      }

   } catch (e) {
      alert(e);
   }

   return {
      vert: vert,
      frag: frag
   };
}

//This function is unreachable code
function reset_image() {
   texture_.image.width = 0;
   texture_.image.height = 0;
   set_resize(1);
   change_canvas_scale(1);
   do_render(NO_ROTATE);
   var output = document.getElementById("image_output");
   output.innerHTML = "None";
}

function set_native_image() {
	texture_.old_img = texture_.image;
	texture_.image = native_Img;
	set_image(texture_.image);
	change_canvas_scale(1);
	do_render(NO_ROTATE);
}
	
document.getElementById("image_file").addEventListener("change", load_image, false);

//3rd function in webGLStart()
function initShaders() {
   progRotate = gl.createProgram();
   progRotate.frag = getShader("Rotation_fragment_shader");
   progRotate.vertex = getShader("Rotation_vertex_shader");
   gl.attachShader(progRotate, progRotate.frag);
   gl.attachShader(progRotate, progRotate.vertex);
   gl.linkProgram(progRotate);

   if (!gl.getProgramParameter(progRotate, gl.LINK_STATUS)) {
      alert("Failed to init rotation shader!");
   }

   progRotate.vert_attr = gl.getAttribLocation(progRotate, "vertexCoord");
   progRotate.tex_attr = gl.getAttribLocation(progRotate, "texCoord");
   progRotate.matrixLoc = gl.getUniformLocation(progRotate, "uMatrix");
   gl.enableVertexAttribArray(progRotate.vert_attr);
   gl.enableVertexAttribArray(progRotate.tex_attr);
   gl.uniform1i(gl.getUniformLocation(progRotate, "imageTexture"), 0);

   texture_ = gl.createTexture();
   texture_.image = new Image();
   texture_.image.width = 0;
   texture_.image.height = 0;
   gl.bindTexture(gl.TEXTURE_2D, texture_);
}

//3rd function in webGLStart()
function initFramebuffer() {
   gl.bindTexture(gl.TEXTURE_2D, texture_);
   gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

//4th function in webGLStart()
function initBuffers() {
   // vert_buf_fbo = gl.createBuffer();
   // gl.bindBuffer(gl.ARRAY_BUFFER, vert_buf_fbo);

   // var fbo_coords = [ // Non-flipped.
      // TEX      // VERT
      // 0.0, 1.0,   -1.0,  1.0,
      // 1.0, 1.0,    1.0,  1.0,
      // 0.0, 0.0,   -1.0, -1.0,
      // 1.0, 0.0,    1.0, -1.0,
      // ];

   // gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fbo_coords), gl.STATIC_DRAW);

   vert_buf = gl.createBuffer();
   gl.bindBuffer(gl.ARRAY_BUFFER, vert_buf);

   var coords = [ // Flipped.
      // TEX      // VERT
      0.0, 0.0,   -1.0,  1.0,
      1.0, 0.0,    1.0,  1.0,
      0.0, 1.0,   -1.0, -1.0,
      1.0, 1.0,    1.0, -1.0,
      ];
   coords.size = 4;

   gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(coords), gl.STATIC_DRAW);

   gl.vertexAttribPointer(progRotate.tex_attr,  2, gl.FLOAT, false, 4 * coords.size, 0 * coords.size);
   gl.vertexAttribPointer(progRotate.vert_attr, 2, gl.FLOAT, false, 4 * coords.size, 2 * coords.size);
}

function rotate(amount, width, height) {
    var modelView = mat4.create();

    mat4.identity(modelView); //Set to identity
    mat4.rotateZ(modelView, modelView, amount); //Rotate around the Z axis
	
	return modelView;
}

function rotate_canvas(canvas) {
	var temp = 0;
	temp = canvas.height
	canvas.height = canvas.width;
	canvas.width = temp;
}

function do_render_regular(rotation) {
	gl.clear(gl.COLOR_BUFFER_BIT);
	var canvas = document.getElementById("test_canvas");
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);

	if (rotation === ROTATE_RIGHT) {
		var modelViewMatrix = rotate(-Math.PI/2, canvas.width, canvas.height);
		rotate_canvas(canvas);
	} else  if (rotation === ROTATE_LEFT) {
		var modelViewMatrix = rotate(Math.PI/2, canvas.width, canvas.height);
		rotate_canvas(canvas);
	} else {
		var modelViewMatrix = rotate(0, canvas.width, canvas.height);
	}

	gl.bindBuffer(gl.ARRAY_BUFFER, vert_buf);
	gl.viewportWidth = canvas.width;
	gl.viewportHeight = canvas.height;

	gl.vertexAttribPointer(progRotate.tex_attr,  2, gl.FLOAT, false, 4 * 4, 0 * 4);
	gl.vertexAttribPointer(progRotate.vert_attr, 2, gl.FLOAT, false, 4 * 4, 2 * 4);

	gl.viewport(0, 0, gl.viewportWidth, gl.viewportHeight);
	gl.uniform2f(gl.getUniformLocation(progRotate, "imageTextureSize"), texture_.image.width, texture_.image.height);
	gl.uniform2f(gl.getUniformLocation(progRotate, "imageInputSize"), texture_.image.width, texture_.image.height);
	gl.uniform2f(gl.getUniformLocation(progRotate, "outputSize"), gl.viewportWidth, gl.viewportHeight);
	gl.uniformMatrix4fv(progRotate.matrixLoc, false, modelViewMatrix);

	gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function do_render(rotation) {
   try {
      if (texture_.image.width == 0 && texture_.image.height == 0)
         return;

      gl.useProgram(progRotate);
      gl.bindTexture(gl.TEXTURE_2D, texture_);

	  do_render_regular(rotation);

      gl.flush();
   } catch (e) {
      alert(e);
   }
}

//This is executed upon the page loading
function webGLStart() {
   try {
      var canvas = document.getElementById("test_canvas");
	  var rotating = true;
      initGL(canvas);

      gl.enable(gl.TEXTURE_2D);
      initFramebuffer();
      initShaders();
      initBuffers();

      gl.viewport(0, 0, gl.viewportWidth, gl.viewportHeight);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
	  
	  do_render(NO_ROTATE);
   } catch (e) {
      alert(e);
   }
}

//----------------------------------------------------------------------

function roundds(f) {
	if (f-Math.floor(f) >= 0.5) {
		return Math.min(Math.ceil(f),32767);
	}
	return Math.max(Math.floor(f),-32768);
}

function memcpy_float32(dst, dstOffset, src, srcOffset, length) {
  var dstFloat32 = new Float32Array(dst, dstOffset, length);
  var srcFloat32 = new Float32Array(src, srcOffset, length);
  dstFloat32.set(srcFloat32);
}

function memcpy_uint8(dst, dstOffset, src, srcOffset, length) {
  var dstUint8 = new Uint8Array(dst, dstOffset, length);
  var srcUint8 = new Uint8Array(src, srcOffset, length);
  dstUint8.set(srcUint8);
}

function memcpy_uint8(dst, dstOffset, src, srcOffset, length) {
  var dstUint8 = new Uint8Array(dst, dstOffset, length);
  var srcUint8 = new Uint8Array(src, srcOffset, length);
  dstUint8.set(srcUint8);
}

/* This does a line-by-line copy from the source pixel array 
 * to the destination pixel array.
 */
function bitblt(dst, dstOffset, dstPitch, src, srcOffset, srcPitch, width, height) {
  var i = 0;
  var curDstOffset = dstOffset;
  var curSrcOffset = srcOffset;
  
  for (i = 0; i < height; ++i) {
	  memcpy_uint8(dst.buffer, curDstOffset, src.buffer, curSrcOffset, width);
	  curDstOffset = curDstOffset + dstPitch;
	  curSrcOffset = curSrcOffset + srcPitch;
  }
}

function modnpf(m, n) {
	if ((m%n) == 0) {
		return m;
	}
	return m+n-(m%n);
}

function cb2(n) {
	return Math.max(Math.min((n),254),0);
}

function setup_weights_and_pscrn() {
	var dims0 = 49*4+5*4+9*4;
	var dims0new = 4*65+4*5;
	var dims1 = NNS_TABLE[g_nns]*2*(XDIA_TABLE[g_nsize]*YDIA_TABLE[g_nsize]+1);
	var dims1offset = 0;
	var dims1tsize = 0; //dims1 table size
	var i = 0;
	var j = 0;	
	var k = 0;	
	
	// $("#BinaryVals").append("<p>");
	
	//dims1tsize is always 1696320, the offset varies based on g_nsize and nns
	for (j = 0; j < NUM_NNS; ++j) {
		for (i = 0; i < NUM_NSIZE; ++i) {
			if (i === g_nsize && j === g_nns) {
				dims1offset = dims1tsize;
			}
			dims1tsize += NNS_TABLE[j]*2*(XDIA_TABLE[i]*YDIA_TABLE[i]+1)*2;
		}
	}
	
	var weights0 = new Float32Array(Math.max(dims0,dims0new));
	//Maybe these should be explicitly declared separate typed arrays...
	var weights1 = []; //Array(2)

	for (i = 0; i < 2; ++i) {
		weights1[i] = new Float32Array(dims1);
	}
	
	if (g_pscrn > 0) {
		//Adjust prescreener weights
		var offt = new Int32Array(4*64);
		
		for (j = 0; j < 4; ++j) {
			for (k = 0; k < 64; ++k) {
				offt[j*64+k] = ((k>>3)<<5)+((j&3)<<3)+(k&7);
			}
		}

		//Offset a certain amount into the file
		var bdw = new Float32Array(g_bdata, (dims0+dims0new*(g_pscrn-2))*Float32Array.BYTES_PER_ELEMENT); //binary data weights0
		var ws0 = new Int16Array(weights0.buffer); //short weights0
		var wf0 = new Float32Array(weights0.buffer, 4*64*Int16Array.BYTES_PER_ELEMENT); //float weights0
		var mean0 = new Float64Array(4);
		var cmean = 0.0;
		
		//Calculate mean weight of each first layer neuron
		for (j = 0; j < 4; ++j) {
			cmean = 0.0;
			for (k = 0; k < 64; ++k) {
				cmean += bdw[offt[j*64+k]];
			}
			mean0[j] = cmean/64.0;
		}
		
		var mval = 0.0;
		var scale = 0.0;
		
		//Factor mean removal and 1.0/127.5 scaling 
		//into first layer weights. scale to int16 range
		for (j = 0; j < 4; ++j) {
			mval = 0.0;
			for (k = 0; k < 64; ++k) {
				mval = Math.max(mval,Math.abs((bdw[offt[j*64+k]]-mean0[j])/127.5));
			}
			scale = 32767.0/mval;
			for (k = 0; k < 64; ++k) {
				ws0[offt[j*64+k]] = roundds(((bdw[offt[j*64+k]]-mean0[j])/127.5)*scale);
			}
			wf0[j] = mval/32767.0;
		}
		var dstOffset = (4*64*Int16Array.BYTES_PER_ELEMENT)+(4*Float32Array.BYTES_PER_ELEMENT);
		var srcOffset = ((dims0+dims0new*(g_pscrn-2))*Float32Array.BYTES_PER_ELEMENT)+(4*64*Float32Array.BYTES_PER_ELEMENT);
		
		memcpy_float32(weights0.buffer, dstOffset, g_bdata, srcOffset, dims0new-4*64);
		offt = null;
		mean0 = null;
	}
	
	//Adjust prediction weights
	for (i = 0; i < 2; ++i) {
		var bdataT = new Float32Array(g_bdata, (dims0+dims0new*3+dims1tsize*g_etype+dims1offset+i*dims1)*Float32Array.BYTES_PER_ELEMENT); //binary data weights1
		var nns = NNS_TABLE[g_nns];
		var asize = XDIA_TABLE[g_nsize]*YDIA_TABLE[g_nsize];
		var boff = nns*2*asize;
		var mean1 = new Float64Array(asize+1+nns*2);
		
		//Calculate mean weight of each neuron (ignore bias)
		for (j = 0; j < nns*2; ++j) {
			cmean = 0.0;
			for (k = 0; k < asize; ++k) {
				cmean += bdataT[j*asize+k];
			}
			mean1[asize+1+j] = cmean/asize;
		}
		
		//Calculate mean softmax neuron
		for (j = 0; j < nns; ++j) {
			for (k = 0; k < asize; ++k) {
				mean1[k] += bdataT[j*asize+k]-mean1[asize+1+j];
			}
			mean1[asize] += bdataT[boff+j];
		}
		for (j = 0; j < asize+1; ++j) {
			mean1[j] /= nns;
		}
		
		//Use int16 dot products (may actually be faster to use float dot products...)
		var ws1 = new Int16Array(weights1[i].buffer); //short weights1[i]
		var wf1 = new Float32Array(weights1[i].buffer, nns*2*asize*Int16Array.BYTES_PER_ELEMENT); //float weights1[i]
		
		//Factor mean removal into weights, remove global offset from
		//softmax neurons, and scale weights to int16 range.
		
		//Softmax neurons
		for (j = 0; j < nns; ++j) {
			mval = 0.0;
			for (k = 0; k < asize; ++k) {
				mval = Math.max(mval,Math.abs(bdataT[j*asize+k]-mean1[asize+1+j]-mean1[k]));
			}
			scale = 32767.0/mval;
			for (k = 0; k < asize; ++k) {
				ws1[j*asize+k] = roundds((bdataT[j*asize+k]-mean1[asize+1+j]-mean1[k])*scale);
			}
			wf1[(j>>2)*8+(j&3)] = mval/32767.0;
			wf1[(j>>2)*8+(j&3)+4] = bdataT[boff+j]-mean1[asize];
		}
		
		//Elliott neurons
		for (j = nns; j < nns*2; ++j) {
			mval = 0.0;
			for (k = 0; k < asize; ++k) {
				mval = Math.max(mval,Math.abs(bdataT[j*asize+k]-mean1[asize+1+j]));
			}
			scale = 32767.0/mval;
			for (k = 0; k < asize; ++k) {
				ws1[j*asize+k] = roundds((bdataT[j*asize+k]-mean1[asize+1+j])*scale);
			}
			wf1[(j>>2)*8+(j&3)] = mval/32767.0;
			wf1[(j>>2)*8+(j&3)+4] = bdataT[boff+j];
		}
		
		mean1 = null;
	}

	var psObj= {};
	psObj['weights0'] = weights0;
	psObj['weights1'] = weights1;
	psObj['nns'] = NNS_TABLE[g_nns];
	psObj['xdia'] = XDIA_TABLE[g_nsize];
	psObj['ydia'] = YDIA_TABLE[g_nsize];
	psObj['asize'] = XDIA_TABLE[g_nsize]*YDIA_TABLE[g_nsize];
	psObj['qual'] = g_qual;
	psObj['pscrn'] = g_pscrn;
	
	return psObj;
}

/* This sets up most of the psinfo object 
 * for a vertical resize of the image.
 * I have no idea if MIN_PAD/MIN_ALIGNMENT is useless or not.
 * It probably is more or less an artifact of SSE.
 */
function setup_psinfo_object(psInfo, srcUnpad, width, height) {
	var srcUnpadPitch = width*4;
	var sHeight = new Int32Array([6, 6, 6]);
	var sHeight2 = new Int32Array(3);
	var eHeight = new Int32Array(3);
	var eHeight2 = new Int32Array(3);
	var input = new Float32Array(512);
	var temp = new Float32Array(2048);
	
	var dstHeight = (height*2);
	var dstWidth = width;
	var dstPitch = dstWidth;
	var dstR = new Uint8Array(dstHeight*dstWidth);
	var dstG = new Uint8Array(dstHeight*dstWidth);
	var dstB = new Uint8Array(dstHeight*dstWidth);
	
	var srcPadHeight = (height*2)+12;
	var srcPadWidth = width+64;
	//var srcPadPitch = modnpf(srcPadWidth+MIN_PAD,MIN_ALIGNMENT);	
	var srcPadPitch = srcPadWidth;
	var srcPadPitch2 = srcPadPitch*2;
	var srcR = new Uint8Array(srcPadHeight*srcPadWidth);
	var srcG = new Uint8Array(srcPadHeight*srcPadWidth);
	var srcB = new Uint8Array(srcPadHeight*srcPadWidth);
	
	psInfo['lcount'] = [];
	psInfo['sheight'] = sHeight; //the number of lines of extra padding at the top and bottom
	psInfo['eheight'] = eHeight; //the doubled height plus the padding at the top and bottom
	psInfo['sheight2'] = sHeight2;
	psInfo['eheight2'] = eHeight2;
	psInfo['src_unpad_pitch'] = srcUnpadPitch;
	psInfo['input'] = input;
	psInfo['temp'] = temp;
	
	psInfo['dst'] = [];
	psInfo['dst'][0] = dstR;
	psInfo['dst'][1] = dstG;
	psInfo['dst'][2] = dstB;
	psInfo['dst_pitch'] = dstPitch;
	psInfo['dst_height'] = dstHeight;
	psInfo['dst_width'] = dstWidth;
	
	psInfo['src'] = [];
	psInfo['src'][0] = srcR;
	psInfo['src'][1] = srcG;
	psInfo['src'][2] = srcB;
	psInfo['src_pitch'] = srcPadPitch;
	psInfo['src_height'] = srcPadHeight;
	psInfo['src_width'] = srcPadWidth;

	for (i = 0; i < 3; ++i) {
		psInfo['lcount'][i] = new Int32Array(dstHeight);
		
		eHeight[i] = sHeight[i] + dstHeight;
	}
}

function upscale_sub(psInfo, srcUnpad, width, height) {
	setup_psinfo_object(psInfo, srcUnpad, width, height);
	
	reorganize_pixels(psInfo, srcUnpad, width, height);

	evalfunc_0(psInfo);
	
	calc_start_end2(psInfo);

	evalfunc_1(psInfo);

	rgbaImgOut = output_rgba_array(psInfo);
	
	return rgbaImgOut;
}

/* We need to pad each channel by 6 pixels on the top 
 * and bottom, and 32 pixels on the left and right.
 * The padding is done by mirror the pixels around the edges.
 * We also need to add a blank line between each line on the y-axis.
 */
function reorganize_pixels(psInfo, srcUnpad, width, height) {
	var y = 0;
	var x = 0;
	var i = 0;
	var srcUnpadPitch = psInfo['src_unpad_pitch'];
	var srcPadHeight = psInfo['src_height'];
	var srcPadWidth = psInfo['src_width'];
	var srcPadPitch = psInfo['src_pitch'];
	var srcR = psInfo['src'][2];
	var srcG = psInfo['src'][1];
	var srcB = psInfo['src'][0];
	var srcPadPitch2 = srcPadPitch*2;
	
	//I could create new typed array views every line to 
	//better emulate the original NNEDI3 code, but that
	//seems like it might be less efficient.
	//Although it would avoid a bunch of pointless multiplications...
	//Using 32-bit pixel manipulation would obviously be faster.
	//I should test both later on 4x upscales of snes screenshots.
	
	//srcUnpad is actually upside-down thanks to gl.readpixels,
	//so we need to flip it while we are padding it.
	var offset = srcUnpadPitch*(height-1)
	var padOffset = (6*srcPadPitch)+32;
	for (y = 0; y < height; ++y) {
		for (x = 0; x < width; ++x) {
			srcR[padOffset+x] = srcUnpad[offset+x*4+0];
			srcG[padOffset+x] = srcUnpad[offset+x*4+1];
			srcB[padOffset+x] = srcUnpad[offset+x*4+2];
		}
		
		offset -= srcUnpadPitch;
		padOffset += srcPadPitch2;
	}
	
	for (i = 0; i < 3; ++i) {
		var dst = psInfo['src'][i];
		offset = 6*srcPadPitch;
		for (y = 6; y < srcPadHeight-6; y+=2) {
			for (x = 0; x < 32; ++x) {
				dst[offset+x] = dst[offset+64-x];
			}
			var c = 2;
			for (x = srcPadWidth-32; x < srcPadWidth; ++x, c+=2) {
				dst[offset+x] = dst[offset+x-c]; 
			}
			offset += srcPadPitch*2;
		}
		//offset = 0;
		for (y = 0; y < 6; y+=2) {
			memcpy_uint8(dst.buffer, y*srcPadPitch, dst.buffer, (12-y)*srcPadPitch, srcPadPitch);
			//offset += 6*srcPadPitch;
		}
		var c = 4;
		//offset = 6*srcPadPitch
		for (y = srcPadHeight-6; y < srcPadHeight; y+=2, c+=4) {
			memcpy_uint8(dst.buffer, y*srcPadPitch, dst.buffer, (y-c)*srcPadPitch, srcPadPitch);
		}
	}
}

/* This function runs the first layer of the neural network.
 * It handles all the prescreening of the data.
 */
function evalfunc_0(psInfo) {
	var i = 0;
	var y = 0;
	var x = 0;

	var input = psInfo['input'];
	var weights0 = psInfo['weights0'];
	var temp = psInfo['temp'];
	var tempu = new Uint8Array(temp.buffer);
	var srcPitch = psInfo['src_pitch'];
	var srcWidth = psInfo['src_width'];
	var dstPitch = psInfo['dst_pitch'];
	var dstWidth = psInfo['dst_width'];
	var sHeight = psInfo['sheight'];
	var eHeight = psInfo['eheight'];

	for (i = 0; i < 3; ++i) {
		var src = psInfo['src'][i];
		var dst = psInfo['dst'][i];
		var lCount = psInfo['lcount'][i];
		var yStart = sHeight[i]+1;
		var yStop = eHeight[i];
		var bbSrcOffset = ((yStart-1)*srcPitch)+32;
		var bbDstOffset = (yStart-7)*dstPitch;
		
		bitblt(dst, bbDstOffset, dstPitch*2, src, bbSrcOffset, srcPitch*2, dstWidth, (eHeight[i]-sHeight[i])>>1)

		var srcOffset = yStart*srcPitch;
		var dstOffset = (yStart-6)*dstPitch-32;
		srcOffset -= srcPitch*3;
		
		if (psInfo['pscrn'] > 0) {
			for (y = yStart; y < yStop; y+=2) {
				for (x = 32; x < srcWidth-32; x+=4) {
					uc2s64(src, srcOffset+x-6 ,srcPitch, input);
					computeNetwork0new(input, weights0, tempu, x);
				}
				lCount[y-yStart+1] += processLine0(tempu, 32, dstWidth, dst, dstOffset+32, src, srcOffset+32, srcPitch);
				srcOffset += srcPitch*2;
				dstOffset += dstPitch*2;
			}
		} else {
			for (y = yStart; y < yStop; y+=2) {
				for (x = 32; x < srcWidth-32; ++x) {
					dst[dstOffset+x] = 255;
				}
				lCount[y-yStart+1] += srcWidth-32;
				dstOffset += dstPitch*2;
			}
		}
	}
}

function uc2s64(t, tOffset, pitch, p) {
	var y = 0;
	var x = 0;
	var ps = new Int16Array(p.buffer);
	
	for (y = 0; y < 4; ++y) {
		for (x = 0; x < 16; ++x) {
			ps[y*16+x] = t[tOffset+(y*pitch*2+x)];
		}
	}
}

function computeNetwork0new(datai, weights, d, dOffset) {
	var i = 0;
	var j = 0;
	var data = new Int16Array(datai.buffer);
	var d32 = new Int32Array(d.buffer, dOffset);
	var ws = new Int16Array(weights.buffer);
	var wf = new Float32Array(ws.buffer, 4*64*Int16Array.BYTES_PER_ELEMENT);
	var vals = new Float32Array(8);
	var sumi = 0;
	var sumf = 0;
	var t = 0;
	var mask = 0;
	
	for (i = 0; i < 4; ++i) {
		sum = 0;
		for (j = 0; j < 64; ++j) {
			sum += data[j]*ws[(i<<3)+((j>>3)<<5)+(j&7)];
		}
		t = sum*wf[i]+wf[4+i];
		vals[i] = t/(1.0+Math.abs(t));
	}
	
	for (i = 0; i < 4; ++i) {
		sum = 0.0;
		for (j = 0; j < 4; ++j) {
			sum += vals[j]*wf[8+i+(j<<2)];
		}
		vals[4+i] = sum+wf[8+16+i];
	}
	
	for (i = 0; i < 4; ++i) {
		if (vals[4+i] > 0.0) {
			mask |= (0x1<<(i<<3));
		}
	}
	d32[0] = mask;
}

/* For each pixel on a line to be generated do either cubic scaling or mark 
 * it with a 255, which means it should be scaled by the neural network.
 */
function processLine0(tempu, tempuOffset, width, dst, dstOffset, src, srcOffset, srcPitch) {
	var x = 0;
	var count = 0;
	
	for (x = 0; x < width; ++x) {
		if (tempu[tempuOffset+x])
			dst[dstOffset+x] = cb2((19*(src[srcOffset+x+srcPitch*2]+src[srcOffset+x+srcPitch*4])-
				3*(src[srcOffset+x]+src[srcOffset+x+srcPitch*6])+16)>>5);
		else {
			dst[dstOffset+x] = 255;
			++count;
		}
	}
	return count;
}

/* This function prepares the input from the first 
 * layer for the second layer of the network.
 * As far as I can tell all this bunch of code does is set:
 * 	var sHeight2 = new Int32Array([1, 1, 1]);
 * 	var eHeight2 = new Int32Array([dstHeight*2, dstHeight*2, dstHeight*2]);
 * I am keeping this here for now for further testing, but I think it is 
 * mostly just leftover threading/deinterlacing code I don't really need.
 */
function calc_start_end2(psInfo) {
	var i = 0;
	var j = 0;
	var sHeight2 = psInfo['sheight2'];
	var eHeight2 = psInfo['eheight2'];
	var dstHeight = psInfo['dst_height'];
	//var dstPitch = psInfo['dst_pitch'];	
	//var dstWidth = psInfo['dst_width'];	
	
	for (i = 0; i < 3; ++i) {
		var dst = psInfo['dst'][i];
		var lCount = psInfo['lcount'][i];
		var total = 0;
		var fl = -1;
		var ll = 0;
		for (j = 0; j < dstHeight; ++j) { 
			total += lCount[j];
			if (fl < 0 && lCount[j] > 0) fl = j;
		}
		if (total === 0) {
			fl = dstHeight;
		} else {
			for (j = dstHeight-1; j >= 0; --j) {
				if (lCount[j]) {
					break;
				}
				++ll;
			}
		}
		
		var tslice = Math.floor(total/1+0.95);
		var count = 0;
		var countt = 0;
		var y = fl;
		var yl = fl;
		var th = 0;
		while (y < dstHeight-ll) {
			count += lCount[y++];
			if (count >= tslice) {
				sHeight2[i] = yl;
				countt += count;
				if (countt === total) {
					y = dstHeight-ll;
				}
				eHeight2[i] = y;
				while (y < dstHeight-ll && lCount[y] === 0) {
					++y;
				}
				yl = y;
				count = 0;
				++th;
			}
		}
		
		//This section might be unreachable code
		if (yl != y) {
			sHeight2[i] = yl;
			countt += count;
			if (countt === total) {
				y = dstHeight-ll;
			}
			eHeight2[i] = y;
			++th;
		}
		
		//This section might be unreachable code
		for (; th < 1; ++th) {
			sHeight2[i] = eHeight2[i] = dstHeight;
		}
	}
}

/* This function runs the second layer of the neural network.
 */
function evalfunc_1(psInfo) {
	var i = 0;
	var x = 0;
	var y = 0;
	
	var input = psInfo['input'];
	var temp = psInfo['temp'];
	var tempFloat = new Int32Array(temp.buffer);
	var weights1 = psInfo['weights1'];
	var qual = psInfo['qual'];
	var asize = psInfo['asize'];
	var nns = psInfo['nns'];
	var xdia = psInfo['xdia'];
	var xdiad2m1 = (xdia>>1)-1;
	var ydia = psInfo['ydia'];
	var scale = 1.0/qual;
	var srcPitch = psInfo['src_pitch'];
	var srcWidth = psInfo['src_width'];
	var dstPitch = psInfo['dst_pitch'];

	for (i = 0; i < 3; ++i) {
		var src = psInfo['src'][i];
		var dst = psInfo['dst'][i];
		var yStart = psInfo['sheight2'][i];
		var yStop = psInfo['eheight2'][i];
		var srcOffset = (yStart+6)*srcPitch;
		var dstOffset = (yStart*dstPitch)-32;
		srcOffset = srcOffset-(ydia-1)*srcPitch-xdiad2m1;
		
		for (y = yStart; y < yStop; y+=2) {
			for (x = 32; x < srcWidth-32; ++x) {
				if (dst[dstOffset+x] != 255) {
					continue;
				}
				var mstd = new Float32Array(4);
				extract_m8_i16(src, srcOffset+x, srcPitch, xdia, ydia, mstd, input);
				for (j = 0; j < qual; ++j) {
					dotProdS(input, weights1[j], temp, nns*2, asize, mstd, 2);
					e0_m16(temp, tempFloat, nns);
					weightedAvgElliottMul5_m16(temp, nns, mstd);
				}
				dst[dstOffset+x] = Math.min(Math.max(Math.floor(mstd[3]*scale+0.5),0),255);
			}
			srcOffset += srcPitch*2;
			dstOffset += dstPitch*2;
		}
	}
}

function extract_m8_i16(src, srcOffset, stride, xdia, ydia, mstd, inputf) {
	var x = 0;
	var y = 0;
	var input = new Int16Array(inputf.buffer);
	var inputOffset = 0;
	var sum = 0;
	var sumsq = 0;
	
	for (y = 0; y < ydia; ++y) {
		var srcOffsetT = srcOffset+y*stride*2;
		for (x = 0; x < xdia; ++x, ++inputOffset) {
			sum += src[srcOffsetT+x];
			sumsq += src[srcOffsetT+x]*src[srcOffsetT+x];
			input[inputOffset] = src[srcOffsetT+x];
		}
	}
	
	var scale = 1.0/(xdia*ydia);
	mstd[0] = sum*scale;
	mstd[1] = sumsq*scale-mstd[0]*mstd[0];
	mstd[3] = 0.0;
	
	if (mstd[1] <= Number.MIN_VALUE) {
		mstd[1] = mstd[2] = 0.0;
	} else {
		mstd[1] = Math.sqrt(mstd[1]);
		mstd[2] = 1.0/mstd[1];
	}
}

function dotProdS(dataf, weightsf, vals, n, len, scale, scaleOffset) {
	var i = 0;
	var j = 0;
	var data = new Int16Array(dataf.buffer);
	var weights = new Int16Array(weightsf.buffer);
	var wf = new Float32Array(weightsf.buffer, (n*len)*Int16Array.BYTES_PER_ELEMENT);
	
	for (i = 0; i < n; ++i) {
		var sum = 0;
		var off = ((i>>2)<<3)+(i&3);
		for (j = 0; j < len; ++j) {
			sum += data[j]*weights[i*len+j];
		}
		vals[i] = sum*wf[off]*scale[2]+wf[off+4];
	}
}

function e0_m16(s, sInt, n) {
	// exp from:  A Fast, Compact Approximation of the Exponential Function (1998)
	//            Nicol N. Schraudolph
	var e0_mult = new Float32Array([// (1.0/ln(2))*(2^23)
		12102203.161561486, 12102203.161561486, 12102203.161561486, 12102203.161561486]);
	var e0_bias = new Float32Array([// (2^23)*127.0-486411.0
		1064866805.0, 1064866805.0, 1064866805.0, 1064866805.0]);
	var exp_lo = new Float32Array([-80.0, -80.0, -80.0, -80.0]);
	var exp_hi = new Float32Array([+80.0, +80.0, +80.0, +80.0]);
	var i = 0;
	
	for (i = 0; i < n; ++i) {
		var t = Math.floor(Math.max(Math.min(s[i],exp_hi[0]),exp_lo[0])*e0_mult[0]+e0_bias[0]);
		sInt[i] = t;
	}
}

function weightedAvgElliottMul5_m16(w, n, mstd) {
	//var min_weight_sum = new Float64Array([1e-10, 1e-10, 1e-10, 1e-10]);
	var vsum = 0.0;
	var wsum = 0.0;
	var i = 0;
	
	for (i = 0; i < n; ++i) {
		vsum += w[i]*(w[n+i]/(1.0+Math.abs(w[n+i])));
		wsum += w[i];
	}
	
	if (wsum > 1e-10) {
		mstd[3] += ((5.0*vsum)/wsum)*mstd[1]+mstd[0];
	} else {
		mstd[3] += mstd[0];
	}
}

/* This function is only needed because the upscaling algorithm 
 * processes each colour channel separately. If I operated
 * directly on an RGBA array I wouldn't have this problem and
 * the whole thing would be a little bit faster (at least
 * according to Chrome's profiler).
 */
function output_rgba_array(psInfo) {
	var y = 0;
	var x = 0;
	var dstHeight = psInfo['dst_height'];
	var dstWidth = psInfo['dst_width'];
	var dstPitch = psInfo['dst_pitch'];
	var dstR = psInfo['dst'][2];
	var dstG = psInfo['dst'][1];
	var dstB = psInfo['dst'][0];
	
	//I wonder when this will be garbage collected?
	var tempCanvas = document.createElement('canvas');
	tempCanvas.height = dstWidth ;
	tempCanvas.width = dstHeight;
	var rgbaImg = tempCanvas.getContext('2d').getImageData(0, 0, dstWidth, dstHeight);
	var rgbaData = rgbaImg.data;
	
	var offset = 0;
	var rgbaOffset = 0;	
	for (y = 0; y < dstHeight; ++y) {
		for (x = 0; x < dstWidth; ++x) {
			rgbaData[rgbaOffset+x*4+0] = dstR[offset+x];
			rgbaData[rgbaOffset+x*4+1] = dstG[offset+x];
			rgbaData[rgbaOffset+x*4+2] = dstB[offset+x];
			rgbaData[rgbaOffset+x*4+3] = 255;
		}
		offset += dstPitch;
		rgbaOffset += dstPitch*4;
	}
	
	return rgbaImg;
}

//This corrects the -0.5 center shift in the upscaled image
function fix_center_shift() {
	//horizontal shift = -0.5
	//vertical shift = -0.5
	//probably resize the upscaled image to size*2 and move 1 pixel right, 1 pixel down
	//then downscale back to the upscaled size
	
	//ex. we take a 256x256 image and put it through nnedi3 at g_rfactor = 2
	//this makes it a 512x512 image with a -0.5 center shift
	//we take the shifted image and upscale it to 1024x1024
	//then we shift it one pixel right and 1 pixel down
	//then we use the same algorithm to downscale it back to 512x512
}

//Output current image to a canvas
//For each main loop iteration
//	Extract the pixels from the image
//	Upscale the pixels by using NNEDI3
//  Put them in an array sized width * (height * 2)
//  Upload this array to the GPU as a texture
//	Rotate this texture to the right 90 degrees
//	Upscale the pixels by using NNEDI3
//  Put them in an array sized (width * 2) * (height * 2)
//  Upload this array to the GPU as a texture
//	Rotate this texture to the left 90 degrees
//	Write the new image out to the canvas
function do_Upscale() {
	var rf = 1; 
	var ct = 0;
	var i = 0;
	var j = 0;
	var k = 0;
	var psInfo = null;
	
	psInfo = setup_weights_and_pscrn();
	
	while (rf < g_rfactor) {
		rf *= 2;
		++ct;
	}
	
	set_native_image();
	
	for (i = 0; i < ct; ++i) {	
		var pixDataA = new Uint8Array((texture_.image.width) * (texture_.image.height) * 4);
		gl.readPixels(0, 0, (texture_.image.width), (texture_.image.height), gl.RGBA, gl.UNSIGNED_BYTE, pixDataA);
		
		halfUpscaled = upscale_sub(psInfo, pixDataA, texture_.image.width, texture_.image.height);

		texture_.old_img = texture_.image;
		texture_.image = halfUpscaled;
		set_image(texture_.image);
		var canvas = document.getElementById("test_canvas");
		canvas.width = texture_.image.width;
		canvas.height = texture_.image.height;
		
		do_render(ROTATE_RIGHT);
		
		var pixDataB = new Uint8Array((texture_.image.width) * (texture_.image.height) * 4);
		gl.readPixels(0, 0, (texture_.image.height), (texture_.image.width), gl.RGBA, gl.UNSIGNED_BYTE, pixDataB);

		fullUpscaled = upscale_sub(psInfo, pixDataB, texture_.image.height, texture_.image.width);

		texture_.old_img = texture_.image;
		texture_.image = fullUpscaled;
		set_image(texture_.image);
		canvas.width = texture_.image.width;
		canvas.height = texture_.image.height;

		do_render(ROTATE_LEFT);
		
		var finalImg = new Image();
		finalImg.src = canvas.toDataURL("image/png");
		
		texture_.old_img = texture_.image;
		texture_.image = finalImg;
		set_image(texture_.image);
		do_render(NO_ROTATE);
	}
	
	//fix_center_shift();
}

function grab_binary() {
	//The numbers in the file will probably be garbage if the device isn't little endian
	var xhr = new XMLHttpRequest;
	xhr.open('GET', 'binary1.bin', true);
	xhr.responseType = 'arraybuffer';
	xhr.onload = function() {
		g_bdata = this.response;
		do_Upscale();
	}

	xhr.send();
}

function print_binary(aBuffer) {
	//This will probably break if the device isn't little endian
	var dataView = new DataView(aBuffer);
	var float32View = new Float32Array(aBuffer);
	
	$("#BinaryVals").append("<p>");
	for (var i=0; i < dims1; i++) {
		$("#BinaryVals").append(float32View[i]+"</br>");
	}
	$("#BinaryVals").append("</p>");
}

function run_NNEDI3() {
	$("#BinaryVals").html('');

	if (g_rfactor === 1) {
		//This actually sets off errors if no image has been uploaded yet
		//But javascript fails silently anyway so who cares
		set_native_image();
	} else {
		if (g_bdata === null) {
			grab_binary()
		} else {
			do_Upscale()
		}
	}
}